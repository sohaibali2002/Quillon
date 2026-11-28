// Pipeline orchestrator: the layer that makes all platform tools work together.
// A goal in plain language becomes a DAG of tool calls — fetch from Salesforce,
// enrich with HubSpot, analyze with code, render an Office document — where each
// step can reference earlier outputs, dependency-free steps run in parallel, and
// the whole pipeline can execute inline or as a durable run that survives a
// crash and resumes at the first incomplete step.
//
// Data passing: any string argument value may be a reference "$stepid.path.to"
// into an earlier step's output, so pipelines move records between platforms
// without glue code.
import { randomUUID } from "node:crypto";
import { generateText, Output, tool, type ToolSet } from "ai";
import { z } from "zod";
import { resolveModelAny } from "@/lib/models";
import {
  catalogText,
  unifiedToolset,
  type ToolCatalogEntry,
  type UnifiedToolset,
} from "@/lib/tool-registry";
import { enqueueRun, getRun, registerRunKind, type DurableStepDef } from "@/lib/durable";
import { getDb } from "@/lib/db";

export const MAX_PIPELINE_STEPS = 12;

export const pipelineStepSchema = z.object({
  id: z
    .string()
    .regex(/^[a-z][a-z0-9_]{0,31}$/, "lowercase id, unique within the pipeline"),
  tool: z.string().min(1),
  purpose: z.string().min(1),
  args: z.record(z.string(), z.unknown()).default({}),
  dependsOn: z.array(z.string()).max(MAX_PIPELINE_STEPS).default([]),
});
export const pipelinePlanSchema = z.object({
  summary: z.string().min(1),
  steps: z.array(pipelineStepSchema).min(1).max(MAX_PIPELINE_STEPS),
});
export type PipelineStep = z.infer<typeof pipelineStepSchema>;
export type PipelinePlan = z.infer<typeof pipelinePlanSchema>;

// ---------------------------------------------------------------------------
// Validation: unknown tools, unknown/duplicate/self dependencies and cycles,
// plus the parallel execution waves (topological order by Kahn levels).
export interface PlanValidation {
  ok: boolean;
  problems: string[];
  warnings: string[];
  waves: string[][];
}

export function validatePlan(plan: PipelinePlan, catalog: ToolCatalogEntry[]): PlanValidation {
  const problems: string[] = [];
  const warnings: string[] = [];
  const known = new Set(catalog.map((t) => t.name));
  const byId = new Map<string, PipelineStep>();

  for (const step of plan.steps) {
    if (byId.has(step.id)) problems.push(`Duplicate step id "${step.id}".`);
    byId.set(step.id, step);
    if (!known.has(step.tool) && !step.tool.startsWith("mcp_")) {
      problems.push(`Step "${step.id}" calls unknown tool "${step.tool}".`);
    }
  }
  for (const step of plan.steps) {
    for (const dep of step.dependsOn) {
      if (dep === step.id) problems.push(`Step "${step.id}" depends on itself.`);
      else if (!byId.has(dep)) problems.push(`Step "${step.id}" depends on missing step "${dep}".`);
    }
  }

  // Kahn levels: only compute a wave order when the graph is acyclic.
  const indegree = new Map<string, number>();
  const children = new Map<string, string[]>();
  for (const step of plan.steps) {
    indegree.set(step.id, 0);
    children.set(step.id, []);
  }
  for (const step of plan.steps) {
    for (const dep of new Set(step.dependsOn)) {
      if (dep !== step.id && byId.has(dep) && indegree.has(dep)) {
        indegree.set(step.id, (indegree.get(step.id) ?? 0) + 1);
        children.get(dep)!.push(step.id);
      }
    }
  }
  const waves: string[][] = [];
  let frontier = [...indegree.entries()].filter(([, d]) => d === 0).map(([id]) => id);
  let seen = 0;
  while (frontier.length > 0) {
    waves.push(frontier);
    seen += frontier.length;
    const next: string[] = [];
    for (const id of frontier) {
      for (const child of children.get(id) ?? []) {
        const d = (indegree.get(child) ?? 0) - 1;
        indegree.set(child, d);
        if (d === 0) next.push(child);
      }
    }
    frontier = next;
  }
  if (seen < plan.steps.length) {
    problems.push("The dependency graph has a cycle; no execution order exists.");
  }
  if (plan.steps.length > 1 && waves.every((w) => w.length === 1) && problems.length === 0) {
    warnings.push("Every step is sequential; independent steps could share dependsOn-free ids to run in parallel.");
  }
  return { ok: problems.length === 0, problems, warnings, waves };
}

// ---------------------------------------------------------------------------
// Reference resolution: "$stepid.path.to.value" pulls from earlier outputs.
export function resolveRefs<T>(value: T, outputs: Record<string, unknown>): T {
  if (typeof value === "string" && value.startsWith("$")) {
    const ref = value.slice(1);
    const dot = ref.indexOf(".");
    const stepId = dot === -1 ? ref : ref.slice(0, dot);
    if (!(stepId in outputs)) {
      throw new Error(`Unresolved reference "${value}": no output from step "${stepId}".`);
    }
    let current: unknown = outputs[stepId];
    if (dot !== -1) {
      for (const key of ref.slice(dot + 1).split(".")) {
        if (current == null || typeof current !== "object") {
          throw new Error(`Unresolved reference "${value}": output of "${stepId}" ends before "${key}".`);
        }
        current = (current as Record<string, unknown>)[key];
      }
    }
    return current as T;
  }
  if (Array.isArray(value)) {
    return value.map((v) => resolveRefs(v, outputs)) as T;
  }
  if (value != null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = resolveRefs(v, outputs);
    }
    return out as T;
  }
  return value;
}

// ---------------------------------------------------------------------------
// Execution. Wave-parallel; every step's result, timing and error are recorded.
export interface StepResult {
  id: string;
  tool: string;
  status: "done" | "error" | "skipped";
  ms: number;
  output?: unknown;
  error?: string;
}

export interface PipelineResult {
  summary: string;
  ok: boolean;
  steps: StepResult[];
  ms: number;
}

async function callTool(
  name: string,
  impl: ToolSet[string],
  args: Record<string, unknown>,
): Promise<unknown> {
  if (!impl?.execute) throw new Error(`Tool "${name}" has no executor.`);
  // Same call shape as mcp.ts: a tool result in a loop without messages.
  return impl.execute(args, { toolCallId: randomUUID(), messages: [], context: {} });
}

export async function executePipeline(
  plan: PipelinePlan,
  tools: ToolSet,
  catalog: ToolCatalogEntry[],
): Promise<PipelineResult> {
  const validation = validatePlan(plan, catalog);
  if (!validation.ok) {
    throw new Error(`Invalid pipeline: ${validation.problems.join(" ")}`);
  }
  const started = Date.now();
  const outputs: Record<string, unknown> = {};
  const results: StepResult[] = [];

  for (const wave of validation.waves) {
    await Promise.all(
      wave.map(async (stepId) => {
        const step = plan.steps.find((s) => s.id === stepId)!;
        const t0 = Date.now();
        try {
          // A failed dependency poisons descendants instead of re-failing tools.
          const failedDep = step.dependsOn.find((d) => results.find((r) => r.id === d)?.status !== "done");
          if (failedDep) {
            results.push({ id: stepId, tool: step.tool, status: "skipped", ms: 0, error: `dependency "${failedDep}" did not complete` });
            return;
          }
          const args = resolveRefs(step.args, outputs);
          const output = await callTool(step.tool, tools[step.tool], args);
          outputs[stepId] = output;
          results.push({ id: stepId, tool: step.tool, status: "done", ms: Date.now() - t0, output });
        } catch (err) {
          results.push({
            id: stepId,
            tool: step.tool,
            status: "error",
            ms: Date.now() - t0,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }),
    );
  }
  const ok = results.every((r) => r.status === "done");
  return { summary: plan.summary, ok, steps: results, ms: Date.now() - started };
}

// ---------------------------------------------------------------------------
// Planning: the model turns a goal into a validated pipeline over the registry.
export async function planPipeline(
  goal: string,
  modelId?: string | null,
  toolset?: UnifiedToolset,
): Promise<{ plan: PipelinePlan; validation: PlanValidation; catalog: ToolCatalogEntry[] }> {
  const unified = toolset ?? (await unifiedToolset("orchestrator"));
  const { output } = await generateText({
    model: await resolveModelAny(modelId),
    output: Output.object({ schema: pipelinePlanSchema }),
    instructions:
      "You are the pipeline planner for an enterprise AI platform. Compose the user's goal into a " +
      `pipeline of 1-${MAX_PIPELINE_STEPS} steps, each calling exactly one tool from this catalog:\n` +
      catalogText(unified.catalog) +
      "\nRules: reference earlier step outputs in string args with \"$stepid.path.to.value\"; " +
      "list each step's real dependencies in dependsOn so independent steps can run in parallel; " +
      "prefer the deepest integration (salesforce_*/hs_* tools over generic connectors).",
    prompt: goal,
  });
  const plan = output;
  return { plan, validation: validatePlan(plan, unified.catalog), catalog: unified.catalog };
}

// ---------------------------------------------------------------------------
// Durable execution: one checkpointed durable step per pipeline step. Each step
// reads earlier outputs from the durable_steps table, so a crashed worker (or a
// fresh process) resumes mid-pipeline without repeating completed tools.
const ORCHESTRATION_KIND_PREFIX = "orchestration-";

export function orchestrationKindFor(plan: PipelinePlan): string {
  return `${ORCHESTRATION_KIND_PREFIX}${plan.steps.length}x-${plan.steps.map((s) => s.tool).join("+").slice(0, 120)}`;
}

function loadPriorOutputs(runId: string, seq: number): Record<string, unknown> {
  const rows = getDb()
    .prepare(
      "SELECT name, output FROM durable_steps WHERE run_id = ? AND seq < ? AND status = 'done' ORDER BY seq",
    )
    .all(runId, seq) as { name: string; output: string | null }[];
  const outputs: Record<string, unknown> = {};
  for (const row of rows) outputs[row.name] = row.output ? JSON.parse(row.output) : null;
  return outputs;
}

export function orchestrationStepDefs(plan: PipelinePlan, tools: ToolSet): DurableStepDef[] {
  return plan.steps.map((step, seq) => ({
    name: step.id,
    run: async (_input: unknown, ctx: { checkpoint: unknown; runId?: string }) => {
      const outputs = ctx.runId ? loadPriorOutputs(ctx.runId, seq) : {};
      const args = resolveRefs(step.args, outputs);
      return callTool(step.tool, tools[step.tool], args);
    },
  }));
}

export async function enqueueOrchestration(
  plan: PipelinePlan,
  tools: ToolSet,
  opts: { goal?: string; org?: string } = {},
): Promise<{ runId: string; kind: string }> {
  const kind = orchestrationKindFor(plan);
  registerRunKind(kind, orchestrationStepDefs(plan, tools));
  const runId = enqueueRun(kind, { goal: opts.goal ?? plan.summary, plan }, orchestrationStepDefs(plan, tools), {
    maxAttempts: 2,
    org: opts.org,
  });
  return { runId, kind };
}

// Rebuild the step registry for a persisted orchestration run in THIS process
// (the worker route calls this before ticking) so replays after restart resume.
export async function resumeOrchestrationRun(runId: string): Promise<boolean> {
  const run = getRun(runId);
  if (!run || !run.kind.startsWith(ORCHESTRATION_KIND_PREFIX)) return false;
  const row = getDb().prepare("SELECT input FROM durable_runs WHERE id = ?").get(runId) as
    | { input: string | undefined }
    | undefined;
  if (!row?.input) return false;
  const { plan } = JSON.parse(row.input) as { plan: PipelinePlan };
  const unified = await unifiedToolset("orchestrator");
  registerRunKind(run.kind, orchestrationStepDefs(plan, unified.tools));
  return true;
}

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Chat tool: delegates multi-tool coordination from a conversation to the
// orchestrator, so the model can hand a whole cross-platform job over instead
// of looping tool calls one at a time.
const orchestrateInputSchema = z.object({
  goal: z.string().min(1).describe("The end-to-end outcome to accomplish."),
});

function clip(value: unknown, max = 1500): unknown {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  if (text == null) return value;
  return text.length > max ? `${text.slice(0, max)}…[truncated]` : value;
}

export function createOrchestrateTool(modelId?: string | null) {
  return tool({
    description:
      "Compose and run a multi-step pipeline across ALL platform tools (Salesforce, HubSpot, " +
      "connectors, code, documents, memory, MCP) from one goal. Use when the request chains " +
      "several tools together or moves data between platforms.",
    inputSchema: orchestrateInputSchema,
    execute: async ({ goal }) => {
      try {
        const unified = await unifiedToolset("orchestrator");
        const { plan, validation, catalog } = await planPipeline(goal, modelId, unified);
        if (!validation.ok) {
          return { ok: false, planned: plan, problems: validation.problems };
        }
        const result = await executePipeline(plan, unified.tools, catalog);
        return {
          ok: result.ok,
          summary: result.summary,
          ms: result.ms,
          steps: result.steps.map((s) => ({ ...s, output: clip(s.output) })),
          warnings: validation.warnings,
        };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  });
}
