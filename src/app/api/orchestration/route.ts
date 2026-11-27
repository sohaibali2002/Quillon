// Orchestration API: goal → validated tool pipeline → inline or durable run.
//   POST { op: "plan", goal, model? }            → plan + validation, no execution
//   POST { op: "run", goal, model? }             → plan then execute inline
//   POST { op: "run-durable", goal, model? }     → plan then enqueue a durable run
//   POST { op: "resume", id }                    → re-register a persisted pipeline's steps, then tick the worker
//   POST { op: "validate", plan }                → validate a client-supplied plan
// GET ?id= lists recent runs (durable) for the Govern-style status views.
import { z } from "zod";
import { guard, audit } from "@/lib/guard";
import { getRun, listRuns, tick } from "@/lib/durable";
import {
  executePipeline,
  enqueueOrchestration,
  pipelinePlanSchema,
  planPipeline,
  resumeOrchestrationRun,
} from "@/lib/orchestrator";
import { unifiedToolset } from "@/lib/tool-registry";

export const maxDuration = 60;

export async function GET(req: Request) {
  const gate = await guard(req);
  if (gate instanceof Response) return gate;
  const id = new URL(req.url).searchParams.get("id");
  if (id) {
    const run = getRun(id);
    if (!run) return Response.json({ error: { message: "Run not found." } }, { status: 404 });
    return Response.json({ run });
  }
  return Response.json({ runs: listRuns(20) });
}

const opSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("plan"), goal: z.string().trim().min(1).max(4000), model: z.string().optional() }),
  z.object({ op: z.literal("run"), goal: z.string().trim().min(1).max(4000), model: z.string().optional() }),
  z.object({ op: z.literal("run-durable"), goal: z.string().trim().min(1).max(4000), model: z.string().optional() }),
  z.object({ op: z.literal("resume"), id: z.string().min(1) }),
  z.object({ op: z.literal("validate"), plan: pipelinePlanSchema }),
]);

export async function POST(req: Request) {
  const gate = await guard(req, { role: "member" });
  if (gate instanceof Response) return gate;
  const parsed = opSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return Response.json(
      { error: { message: "Invalid orchestration request.", issues: parsed.error.issues.map((i) => i.message) } },
      { status: 400 },
    );
  }
  const body = parsed.data;

  if (body.op === "validate") {
    const unified = await unifiedToolset("orchestrator");
    const { validatePlan } = await import("@/lib/orchestrator");
    return Response.json(validatePlan(body.plan, unified.catalog));
  }

  if (body.op === "resume") {
    const ok = await resumeOrchestrationRun(body.id);
    if (!ok) {
      return Response.json({ error: { message: "Not a resumable orchestration run." } }, { status: 404 });
    }
    const ran = await tick();
    audit(req, gate, "orchestration.resume", body.id, { ran });
    return Response.json({ ok: true, ran });
  }

  // plan / run / run-durable share the planning step.
  const unified = await unifiedToolset("orchestrator");
  const { plan, validation, catalog } = await planPipeline(body.goal, body.model, unified);
  if (!validation.ok) {
    return Response.json(
      { error: { message: "The planner produced an invalid pipeline.", problems: validation.problems, plan } },
      { status: 422 },
    );
  }

  if (body.op === "plan") {
    return Response.json({ plan, validation, catalog });
  }

  if (body.op === "run") {
    const result = await executePipeline(plan, unified.tools, catalog);
    audit(req, gate, "orchestration.run", plan.summary.slice(0, 80), { ok: result.ok, steps: result.steps.length });
    return Response.json({ plan, validation, result });
  }

  const { runId, kind } = await enqueueOrchestration(plan, unified.tools, { goal: body.goal });
  audit(req, gate, "orchestration.enqueue", runId, { kind, steps: plan.steps.length });
  return Response.json({ runId, kind, plan, validation });
}
