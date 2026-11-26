async function secure(req: Request) {
  const gate = await guard(req);
  if (gate instanceof Response) return gate;
  return gate;
}

// Multi-agent workflow route: orchestrator -> parallel workers -> synthesizer,
// streamed as a UI message stream. Custom data parts (data-plan, data-task,
// data-summary) let the panel show each stage live as it completes.
//   Body: { prompt, model? }
import { createUIMessageStream, createUIMessageStreamResponse } from "ai";
import { z } from "zod";
import { guard } from "@/lib/guard";
import {
  runOrchestrator,
  runSynthesizer,
  runWorkers,
  type PlanPart,
  type SummaryPart,
  type TaskPart,
  type WorkerMeta,
  type WorkerResult,
} from "@/lib/workflow";

export const maxDuration = 120;

const bodySchema = z.object({
  prompt: z.string().min(1, "Give the orchestrator something to plan.").optional(),
  model: z.string().optional(),
  messages: z.array(z.unknown()).optional(),
});

// useChat sends {messages: UIMessage[]}; direct callers may send {prompt}.
function promptFrom(body: { prompt?: string; messages?: unknown[] }) {
  if (body.prompt) return body.prompt;
  const lastUser = [...(body.messages ?? [])]
    .reverse()
    .find((m) => (m as { role?: string })?.role === "user");
  if (lastUser) {
    const parts = ((lastUser as { parts?: unknown[] }).parts ?? []).filter(
      (p) => (p as { type?: string })?.type === "text",
    );
    const text = parts
      .map((p) => (p as { text?: string }).text ?? "")
      .join(" ")
      .trim();
    if (text) return text;
  }
  return undefined;
}

export async function POST(req: Request) {
  const denied = await secure(req);
  if (denied instanceof Response) return denied;

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return Response.json(
      { error: { message: "Request body must be valid JSON." } },
      { status: 400 },
    );
  }

  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) {
    return Response.json(
      {
        error: {
          message: "Invalid request body.",
          issues: parsed.error.issues.map((i) => ({
            path: i.path.join("."),
            message: i.message,
          })),
        },
      },
      { status: 400 },
    );
  }
  const prompt = promptFrom(parsed.data);
  if (!prompt) {
    return Response.json(
      { error: { message: "Missing prompt: send {prompt} or a useChat messages array." } },
      { status: 400 },
    );
  }
  const { model } = parsed.data;

  const stream = createUIMessageStream({
    execute: async ({ writer }) => {
      const started = Date.now();
      let planMs = 0;
      let workersMs = 0;
      let synthMs = 0;
      let planTokens = 0;
      let synthTokens = 0;
      const workerMeta = new Map<number, WorkerMeta>();
      try {
        // Stage 1: orchestrator plans the subtasks.
        const orchestrated = await runOrchestrator(model, prompt);
        const plan = orchestrated.plan;
        planTokens = orchestrated.tokens;
        planMs = Date.now() - started;
        writer.write({
          type: "data-plan" as const,
          data: {
            ...plan,
            ms: planMs,
            model: model ?? "gateway default",
          } satisfies PlanPart,
        });

        // Stage 2: specialist workers run in parallel; each lands as it finishes.
        const workersStart = Date.now();
        const results = (await runWorkers(model, plan, prompt, (index, result, meta) => {
          workerMeta.set(index, meta);
          writer.write({
            type: "data-task" as const,
            data: {
              index,
              title: plan.tasks[index]?.title ?? `Task ${index + 1}`,
              kind: plan.tasks[index]?.kind ?? "analysis",
              result,
              meta,
            } satisfies TaskPart,
          });
        })) as WorkerResult[];
        workersMs = Date.now() - workersStart;

        // Stage 3: synthesizer merges everything into one answer.
        const synthStart = Date.now();
        const synthesized = await runSynthesizer(model, prompt, plan, results);
        synthMs = Date.now() - synthStart;
        synthTokens = synthesized.tokens;
        writer.write({ type: "text-start", id: "synthesis" });
        writer.write({ type: "text-delta", id: "synthesis", delta: synthesized.text });
        writer.write({ type: "text-end", id: "synthesis" });

        const timed = [...workerMeta.entries()].map(([index, meta]) => ({
          title: plan.tasks[index]?.title ?? `Task ${index + 1}`,
          ms: meta.ms,
        }));
        const slowest = timed.length
          ? timed.reduce((a, b) => (a.ms >= b.ms ? a : b))
          : null;
        const fastest = timed.length
          ? timed.reduce((a, b) => (a.ms <= b.ms ? a : b))
          : null;
        writer.write({
          type: "data-summary" as const,
          data: {
            tasks: plan.tasks.length,
            ms: Date.now() - started,
            breakdown: { planMs, workersMs, synthMs },
            tokens:
              planTokens +
              synthTokens +
              [...workerMeta.values()].reduce((sum, m) => sum + m.tokens, 0),
            slowest,
            fastest,
            model: model ?? "gateway default",
          } satisfies SummaryPart,
        });
      } catch (error) {
        writer.write({
          type: "data-summary" as const,
          data: {
            tasks: workerMeta.size,
            ms: Date.now() - started,
            breakdown: { planMs, workersMs, synthMs },
            tokens: planTokens + synthTokens,
            slowest: null,
            fastest: null,
            model: model ?? "gateway default",
            error:
              error instanceof Error ? error.message : "Workflow failed.",
          } satisfies SummaryPart,
        });
      }
    },
    onError: (error) =>
      error instanceof Error ? error.message : "Workflow failed.",
  });

  return createUIMessageStreamResponse({ stream });
}
