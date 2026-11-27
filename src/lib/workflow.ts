// Multi-agent workflow, following the AI SDK "Workflow Patterns" docs:
// https://ai-sdk.dev/docs/agents/workflows (Orchestrator-Worker pattern).
//
// The orchestrator plans subtasks with a structured output schema, workers run
// in parallel (Promise.all), each a specialist, and a synthesizer aggregates
// their results. Every stage is a separate agent with its own instructions.
import { generateText, Output, stepCountIs, ToolLoopAgent } from "ai";
import { z } from "zod";
import { resolveModelAny } from "@/lib/models";
import { builtinTools } from "@/lib/tools";

export const MAX_TASKS = 5;

export const planSchema = z.object({
  tasks: z
    .array(
      z.object({
        title: z.string(),
        description: z.string(),
        kind: z.enum(["research", "analysis", "implementation"]),
      }),
    )
    .max(MAX_TASKS),
  estimatedComplexity: z.enum(["low", "medium", "high"]),
});
export type Plan = z.infer<typeof planSchema>;

export const workerSchema = z.object({
  explanation: z.string(),
  result: z.string(),
});
export type WorkerResult = z.infer<typeof workerSchema>;

// Per-worker telemetry: what the card shows beyond the text result.
export type WorkerMeta = {
  /** Wall time from spawn to result for this worker. */
  ms: number;
  /** Agent loop steps that ran (1 = no tool round trip). */
  steps: number;
  /** Distinct tool names the worker called, in first-use order. */
  tools: string[];
  /** Total tokens billed for this worker across every step. */
  tokens: number;
  /** Position in which this worker finished (1 = first to land). */
  arrival: number;
};

// Custom UI-message data parts streamed by the /api/workflow route.
export type PlanPart = Plan & { ms: number; model: string };
export type TaskPart = {
  index: number;
  title: string;
  kind: Plan["tasks"][number]["kind"];
  result: WorkerResult;
  meta: WorkerMeta;
};
export type SummaryPart = {
  tasks: number;
  ms: number;
  /** Stage split so the panel can draw where the time went. */
  breakdown: { planMs: number; workersMs: number; synthMs: number };
  tokens: number;
  slowest: { title: string; ms: number } | null;
  fastest: { title: string; ms: number } | null;
  model: string;
  error?: string;
};

const WORKER_INSTRUCTIONS: Record<Plan["tasks"][number]["kind"], string> = {
  research:
    "You are a research specialist. Gather the facts relevant to the subtask and cite what you relied on.",
  analysis:
    "You are an analysis specialist. Weigh evidence and trade-offs, and state the implication of each.",
  implementation:
    "You are an implementation specialist. Produce concrete, complete output for the subtask.",
};

/** Orchestrator agent: turns a request into a plan of parallel subtasks. */
export async function runOrchestrator(modelId: string | undefined, prompt: string) {
  const { output: plan, totalUsage } = await generateText({
    model: await resolveModelAny(modelId),
    output: Output.object({ schema: planSchema }),
    instructions:
      "You are the orchestrator. Break the request into 1-5 independent subtasks. " +
      "Each subtask must be completable on its own by a specialist worker.",
    prompt,
  });
  return { plan, tokens: totalUsage.totalTokens ?? 0 };
}

/** Worker agents: run the planned subtasks in parallel, tools allowed. */
export async function runWorkers(
  modelId: string | undefined,
  plan: Plan,
  prompt: string,
  onDone?: (index: number, result: WorkerResult, meta: WorkerMeta) => void,
): Promise<WorkerResult[]> {
  const finished: number[] = [];
  return Promise.all(
    plan.tasks.map(async (task, index) => {
      const started = Date.now();
      const worker = new ToolLoopAgent({
        model: await resolveModelAny(modelId),
        instructions: WORKER_INSTRUCTIONS[task.kind],
        tools: builtinTools,
        stopWhen: stepCountIs(5),
        output: Output.object({ schema: workerSchema }),
      });
      const { output, steps, totalUsage } = await worker.generate({
        prompt: `Overall request: ${prompt}\n\nYour subtask (${task.kind}): ${task.title} — ${task.description}`,
      });
      finished.push(index);
      onDone?.(index, output, {
        ms: Date.now() - started,
        steps: steps.length,
        tools: [...new Set(steps.flatMap((s) => s.toolCalls.map((c) => c.toolName)))],
        tokens: totalUsage.totalTokens ?? 0,
        arrival: finished.length,
      });
      return output;
    }),
  );
}

/** Synthesizer agent: aggregates worker outputs into one answer. */
export async function runSynthesizer(
  modelId: string | undefined,
  prompt: string,
  plan: Plan,
  results: WorkerResult[],
) {
  const { text, totalUsage } = await generateText({
    model: await resolveModelAny(modelId),
    instructions:
      "You are the synthesizer. Merge the workers' results into one coherent answer for the original request. Do not list raw JSON.",
    prompt: `Original request: ${prompt}

Subtask plan:
${plan.tasks.map((t, i) => `${i + 1}. [${t.kind}] ${t.title}`).join("\n")}

Worker results:
${JSON.stringify(
  plan.tasks.map((t, i) => ({ title: t.title, result: results[i]?.result ?? "" })),
  null,
  2,
)}`,
  });
  return { text, tokens: totalUsage.totalTokens ?? 0 };
}
