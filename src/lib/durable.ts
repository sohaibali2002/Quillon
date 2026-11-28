// Durable execution: a queue of runs with per-step checkpoints.
//
// A run is a list of steps. Each completed step's output is persisted, so a
// worker that dies (server restart, crash, deploy) can pick the run back up and
// resume at the first non-completed step instead of repeating finished work.
// Leases make concurrent workers safe; attempts + dead-letter bound retries.
import { randomUUID } from "node:crypto";
import { getDb } from "@/lib/db";

export type RunStatus = "pending" | "running" | "paused" | "done" | "error" | "dead";
export type StepStatus = "pending" | "running" | "done" | "error" | "skipped";

export interface DurableStepDef {
  name: string;
  run: (input: unknown, ctx: { checkpoint: unknown; runId: string }) => Promise<unknown>;
}

const LEASE_MS = 60_000;

export interface DurableRun {
  id: string;
  kind: string;
  status: RunStatus;
  priority: number;
  attempts: number;
  max_attempts: number;
  checkpoint: unknown;
  result: unknown;
  error: string | null;
  created_at: string;
  steps?: { seq: number; name: string; status: StepStatus; error: string | null }[];
}

function rowToRun(r: Record<string, unknown>): DurableRun {
  return {
    id: String(r.id),
    kind: String(r.kind),
    status: r.status as RunStatus,
    priority: Number(r.priority),
    attempts: Number(r.attempts),
    max_attempts: Number(r.max_attempts),
    checkpoint: r.checkpoint ? JSON.parse(String(r.checkpoint)) : null,
    result: r.result ? JSON.parse(String(r.result)) : null,
    error: (r.error as string | null) ?? null,
    created_at: String(r.created_at),
  };
}

export function enqueueRun(
  kind: string,
  input: unknown,
  steps: DurableStepDef[],
  opts: { priority?: number; maxAttempts?: number; org?: string } = {},
): string {
  const db = getDb();
  const id = randomUUID();
  db.prepare(
    "INSERT INTO durable_runs (id, org, kind, input, status, priority, max_attempts) VALUES (?, ?, ?, ?, 'pending', ?, ?)",
  ).run(id, opts.org?.trim() || "default", kind, JSON.stringify(input), opts.priority ?? 5, opts.maxAttempts ?? 3);
  const ins = db.prepare(
    "INSERT INTO durable_steps (run_id, seq, name) VALUES (?, ?, ?)",
  );
  steps.forEach((s, i) => ins.run(id, i, s.name));
  return id;
}

export function getRun(id: string, org?: string): DurableRun | null {
  if (!org?.trim()) return null;
  const row = getDb().prepare("SELECT * FROM durable_runs WHERE id = ? AND org = ?").get(id, org.trim()) as
    | Record<string, unknown>
    | undefined;
  if (!row) return null;
  const run = rowToRun(row);
  run.steps = (
    getDb()
      .prepare("SELECT seq, name, status, error FROM durable_steps WHERE run_id = ? ORDER BY seq")
      .all(id) as Record<string, unknown>[]
  ).map((s) => ({
    seq: Number(s.seq),
    name: String(s.name),
    status: s.status as StepStatus,
    error: (s.error as string | null) ?? null,
  }));
  return run;
}

/** Runs visible to a tenant; without an org this returns nothing (fail closed). */
export function listRuns(limit = 50, org?: string): DurableRun[] {
  if (!org?.trim()) return [];
  return (
    getDb()
      .prepare("SELECT * FROM durable_runs WHERE org = ? ORDER BY created_at DESC LIMIT ?")
      .all(org.trim(), limit) as Record<string, unknown>[]
  ).map(rowToRun);
}

// Claim the next runnable run with a lease so several workers can share the
// queue without double-executing. Expired leases (crashed workers) are fair game.
function claimNext(
  workerId: string,
  tenant?: string | null,
): { id: string; input: unknown; checkpoint: unknown; max_attempts: number; attempts: number } | null {
  const db = getDb();
  const now = new Date().toISOString();
  const lease = new Date(Date.now() + LEASE_MS).toISOString();
  // A caller-scoped tick only takes that tenant's work; the unscoped form is for
  // cron and unattended workers that own the whole queue.
  const scope = tenant?.trim();
  const tenantClause = scope ? " AND org = ?" : "";
  const tenantArg = scope ? [scope] : [];
  db.prepare("UPDATE durable_runs SET status='running' WHERE status='running' AND lease_until < ?").run(now);
  const candidate = db
    .prepare(
      `SELECT id, input, checkpoint, max_attempts, attempts FROM durable_runs WHERE (status = 'pending' OR (status='running' AND (lease_until IS NULL OR lease_until < ?)))${tenantClause} ORDER BY priority ASC, created_at ASC LIMIT 1`,
    )
    .get(now, ...tenantArg) as Record<string, unknown> | undefined;
  if (!candidate) return null;
  const claimed = db
    .prepare(
      `UPDATE durable_runs SET status='running', worker_id=?, lease_until=?, attempts=attempts+1 WHERE id=? AND (status='pending' OR (status='running' AND (lease_until IS NULL OR lease_until < ?)))${tenantClause} RETURNING attempts`,
    )
    .get(workerId, lease, String(candidate.id), now, ...tenantArg) as { attempts: number } | undefined;
  if (!claimed) return null;
  return {
    id: String(candidate.id),
    input: JSON.parse(String(candidate.input)),
    checkpoint: candidate.checkpoint ? JSON.parse(String(candidate.checkpoint)) : null,
    max_attempts: Number(candidate.max_attempts),
    attempts: Number(claimed.attempts),
  };
}

function firstIncompleteStep(runId: string): number {
  const row = getDb()
    .prepare("SELECT MIN(seq) AS seq FROM durable_steps WHERE run_id = ? AND status != 'done'")
    .get(runId) as { seq: number | null };
  return row.seq ?? -1;
}

// Extend this worker's lease. Returns false when the worker no longer owns the
// run (lease expired, another worker claimed it) — the caller must stop.
function renewLease(runId: string, workerId: string): boolean {
  const lease = new Date(Date.now() + LEASE_MS).toISOString();
  const res = getDb()
    .prepare("UPDATE durable_runs SET lease_until=? WHERE id=? AND worker_id=? AND status='running'")
    .run(lease, runId, workerId);
  return res.changes > 0;
}

class LeaseLostError extends Error {
  constructor() {
    super("Lease lost: another worker claimed this run.");
  }
}

// Execute a claimed run: skip completed steps, run the rest, checkpointing
// after each. On failure, retry (back to pending with delay via lease expiry)
// until max_attempts, then dead-letter.
export async function tick(
  workerId = `w-${process.pid}`,
  opts: { heartbeatMs?: number; tenant?: string | null } = {},
): Promise<string | null> {
  const claimed = claimNext(workerId, opts.tenant);
  if (!claimed) return null;
  const db = getDb();
  const { id } = claimed;
  const registry = stepRegistry();
  const defs = registry.get(runKind(id));
  if (!defs) {
    db.prepare("UPDATE durable_runs SET status='error', error=?, updated_at=? WHERE id=?")
      .run(`No step registry for kind "${runKind(id)}" in this process; register it with registerRunKind().`, new Date().toISOString(), id);
    return id;
  }
  const stepDefs = defs;
  const start = firstIncompleteStep(id);
  // Heartbeat: renew the lease every LEASE_MS/3 so a long-running step (longer
  // than the base lease) is not stolen by another worker mid-execution. If the
  // lease is lost anyway, this worker aborts without writing run state — the
  // step may be re-executed by the new owner, so results stay single-writer.
  let leaseLost = false;
  const heartbeat = setInterval(() => {
    if (!renewLease(id, workerId)) leaseLost = true;
  }, Math.max(20, opts.heartbeatMs ?? LEASE_MS / 3));
  heartbeat.unref?.();
  try {
    let ctx: { checkpoint: unknown; runId: string } = { checkpoint: claimed.checkpoint, runId: id };
    for (let seq = start; seq >= 0 && seq < stepDefs.length; seq++) {
      if (leaseLost) throw new LeaseLostError();
      const def = stepDefs[seq];
      const started = new Date().toISOString();
      db.prepare("UPDATE durable_steps SET status='running', started_at=? WHERE run_id=? AND seq=?").run(started, id, seq);
      try {
        const output = await def.run(claimed.input, ctx);
        if (leaseLost) throw new LeaseLostError();
        db.prepare("UPDATE durable_steps SET status='done', output=?, finished_at=? WHERE run_id=? AND seq=?")
          .run(JSON.stringify(output ?? null), new Date().toISOString(), id, seq);
        ctx = { checkpoint: { lastStep: def.name, output }, runId: id };
        db.prepare("UPDATE durable_runs SET checkpoint=?, updated_at=? WHERE id=?")
          .run(JSON.stringify({ lastStep: def.name, output }), new Date().toISOString(), id);
      } catch (err) {
        if (err instanceof LeaseLostError) throw err;
        const message = err instanceof Error ? err.message : String(err);
        db.prepare("UPDATE durable_steps SET status='error', error=?, finished_at=? WHERE run_id=? AND seq=?")
          .run(message, new Date().toISOString(), id, seq);
        throw err;
      }
    }
    const doneSteps = db.prepare("SELECT COUNT(*) AS n FROM durable_steps WHERE run_id=? AND status='done'").get(id) as { n: number };
    if (doneSteps.n >= defs.length) {
      const last = db.prepare("SELECT output FROM durable_steps WHERE run_id=? ORDER BY seq DESC LIMIT 1").get(id) as { output: string | null } | undefined;
      db.prepare("UPDATE durable_runs SET status='done', result=?, error=NULL, updated_at=? WHERE id=?")
        .run(last?.output ?? "null", new Date().toISOString(), id);
    }
    return id;
  } catch (err) {
    if (err instanceof LeaseLostError) {
      // The run now belongs to another worker; leave its state untouched.
      return id;
    }
    const message = err instanceof Error ? err.message : String(err);
    const dead = claimed.attempts >= claimed.max_attempts;
    db.prepare("UPDATE durable_runs SET status=?, error=?, updated_at=? WHERE id=?")
      .run(dead ? "dead" : "pending", message, new Date().toISOString(), id);
    return id;
  } finally {
    clearInterval(heartbeat);
  }
}

function runKind(runId: string): string {
  const row = getDb().prepare("SELECT kind FROM durable_runs WHERE id=?").get(runId) as { kind: string } | undefined;
  return row?.kind ?? "";
}

// Registries: kind -> ordered steps. registerRunKind before enqueueing.
const registry = new Map<string, DurableStepDef[]>();
export function registerRunKind(kind: string, steps: DurableStepDef[]) {
  registry.set(kind, steps);
}
function stepRegistry() {
  return registry;
}

// Drain up to n runs; used by the worker route and by tests.
export async function drain(max = 5): Promise<string[]> {
  const done: string[] = [];
  for (let i = 0; i < max; i++) {
    const id = await tick();
    if (!id) break;
    done.push(id);
  }
  return done;
}

// Recovery sweep: requeue runs whose worker died mid-step (lease expired) and
// report dead runs so operators can inspect + replay them.
export function recoverySweep(): { requeued: number; dead: number } {
  const db = getDb();
  const now = new Date().toISOString();
  const requeued = Number(db
    .prepare("UPDATE durable_runs SET status='pending', worker_id=NULL, lease_until=NULL WHERE status='running' AND lease_until < ?")
    .run(now).changes);
  const dead = Number(
    (db.prepare("SELECT COUNT(*) AS n FROM durable_runs WHERE status='dead'").get() as { n: number }).n,
  );
  return { requeued, dead };
}

// Replay a dead run: reset it and its erroring step for another attempt cycle.
// Scoped to the caller's tenant so an id from elsewhere does nothing.
export function replayRun(id: string, org?: string): boolean {
  if (!org?.trim()) return false;
  const db = getDb();
  const res = db
    .prepare("UPDATE durable_runs SET status='pending', attempts=0, error=NULL, lease_until=NULL, worker_id=NULL WHERE id=? AND org=? AND status IN ('dead','error')")
    .run(id, org.trim());
  if (res.changes) {
    db.prepare("UPDATE durable_steps SET status='pending', error=NULL WHERE run_id=? AND status='error'").run(id);
  }
  return res.changes > 0;
}
