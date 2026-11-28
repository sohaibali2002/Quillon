// Unattended jobs: create, schedule and run prompts without a person watching.
//
// A job pairs a prompt with a model and a schedule. Runs are executed by
// POST /api/jobs/run (a cron, the setup wizard's health check or a manual tap)
// and recorded in job_runs with status, output and duration.

import { randomUUID } from "node:crypto";
import { getDb } from "@/lib/db";
import { resolveModelAny } from "@/lib/models";
import { tenantScope } from "@/lib/tenant-context";
import { generateText } from "ai";

export type Job = {
  id: string;
  name: string;
  prompt: string;
  model: string | null;
  schedule: "manual" | "hourly" | "daily" | "weekly";
  packageId: string | null;
  enabled: boolean;
  lastRunAt: string | null;
  nextRunAt: string | null;
};

export type JobRun = {
  id: string;
  jobId: string;
  status: "running" | "done" | "error";
  output: string;
  error: string | null;
  durationMs: number | null;
  startedAt: string;
};

function rowToJob(r: Record<string, unknown>): Job {
  return {
    id: String(r.id),
    name: String(r.name),
    prompt: String(r.prompt),
    model: (r.model as string | null) ?? null,
    schedule: r.schedule as Job["schedule"],
    packageId: (r.package_id as string | null) ?? null,
    enabled: Number(r.enabled) === 1,
    lastRunAt: (r.last_run_at as string | null) ?? null,
    nextRunAt: (r.next_run_at as string | null) ?? null,
  };
}

export function listJobs(tenant?: string | null): Job[] {
  return (
    getDb()
      .prepare("SELECT * FROM jobs WHERE tenant_id = ? ORDER BY created_at DESC")
      .all(tenantScope(tenant)) as Record<string, unknown>[]
  ).map(rowToJob);
}

export function getJob(id: string, tenant?: string | null): Job | null {
  const r = getDb()
    .prepare("SELECT * FROM jobs WHERE id = ? AND tenant_id = ?")
    .get(id, tenantScope(tenant)) as Record<string, unknown> | undefined;
  return r ? rowToJob(r) : null;
}

const INTERVAL_HOURS: Record<Job["schedule"], number | null> = {
  manual: null,
  hourly: 1,
  daily: 24,
  weekly: 168,
};

export function createJob(input: {
  name: string;
  prompt: string;
  model?: string;
  schedule?: Job["schedule"];
  packageId?: string;
  tenant?: string | null;
}): Job {
  const id = randomUUID();
  const schedule = input.schedule ?? "manual";
  const tenant = tenantScope(input.tenant);
  const next = INTERVAL_HOURS[schedule]
    ? new Date(Date.now() + INTERVAL_HOURS[schedule]! * 3600_000).toISOString()
    : null;
  getDb()
    .prepare(
      "INSERT INTO jobs (id, tenant_id, name, prompt, model, schedule, package_id, next_run_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .run(id, tenant, input.name, input.prompt, input.model ?? null, schedule, input.packageId ?? null, next);
  return getJob(id, tenant)!;
}

export function updateJob(
  id: string,
  patch: Partial<Pick<Job, "name" | "prompt" | "model" | "schedule" | "enabled">>,
  tenant?: string | null,
): Job | null {
  const job = getJob(id, tenant);
  if (!job) return null;
  const next = patch.schedule && INTERVAL_HOURS[patch.schedule]
    ? new Date(Date.now() + INTERVAL_HOURS[patch.schedule]! * 3600_000).toISOString()
    : job.nextRunAt;
  getDb()
    .prepare(
      `UPDATE jobs SET name = ?, prompt = ?, model = ?, schedule = ?, enabled = ?, next_run_at = ? WHERE id = ? AND tenant_id = ?`,
    )
    .run(
      patch.name ?? job.name,
      patch.prompt ?? job.prompt,
      patch.model ?? job.model,
      patch.schedule ?? job.schedule,
      patch.enabled === undefined ? (job.enabled ? 1 : 0) : patch.enabled ? 1 : 0,
      next,
      id,
      tenantScope(tenant),
    );
  return getJob(id, tenant);
}

export function deleteJob(id: string, tenant?: string | null): boolean {
  return getDb()
    .prepare("DELETE FROM jobs WHERE id = ? AND tenant_id = ?")
    .run(id, tenantScope(tenant)).changes > 0;
}

export function listRuns(jobId: string, limit = 20): JobRun[] {
  return (
    getDb()
      .prepare("SELECT * FROM job_runs WHERE job_id = ? ORDER BY started_at DESC LIMIT ?")
      .all(jobId, limit) as Record<string, unknown>[]
  ).map((r) => ({
    id: String(r.id),
    jobId: String(r.job_id),
    status: r.status as JobRun["status"],
    output: String(r.output ?? ""),
    error: (r.error as string | null) ?? null,
    durationMs: (r.duration_ms as number | null) ?? null,
    startedAt: String(r.started_at),
  }));
}

export async function runJob(id: string): Promise<JobRun> {
  const job = getJob(id);
  if (!job) throw new Error("job not found");
  const runId = randomUUID();
  const started = Date.now();
  getDb().prepare("INSERT INTO job_runs (id, job_id, status) VALUES (?, ?, 'running')").run(runId, id);
  try {
    const model = await resolveModelAny(job.model);
    const { text } = await generateText({ model, prompt: job.prompt });
    const duration = Date.now() - started;
    getDb()
      .prepare("UPDATE job_runs SET status = 'done', output = ?, duration_ms = ? WHERE id = ?")
      .run(text, duration, runId);
    const next = INTERVAL_HOURS[job.schedule]
      ? new Date(Date.now() + INTERVAL_HOURS[job.schedule]! * 3600_000).toISOString()
      : null;
    getDb()
      .prepare("UPDATE jobs SET last_run_at = ?, next_run_at = ? WHERE id = ?")
      .run(new Date().toISOString(), next, id);
    return { id: runId, jobId: id, status: "done", output: text, error: null, durationMs: duration, startedAt: new Date().toISOString() };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    getDb()
      .prepare("UPDATE job_runs SET status = 'error', error = ?, duration_ms = ? WHERE id = ?")
      .run(message, Date.now() - started, runId);
    return { id: runId, jobId: id, status: "error", output: "", error: message, durationMs: Date.now() - started, startedAt: new Date().toISOString() };
  }
}
