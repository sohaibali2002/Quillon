// Quillon Transaction Engine: every consequential agent action follows
// plan → simulate → approve → execute → verify → compensate.
//
// An action declares `execute` (do the real thing) and `undo` (compensating
// action). Nothing executes until a human approves the simulated plan; each
// executed action's result and undo payload are stored so the transaction can
// be rolled back in reverse order, and every event is written to agent_replay
// for full inspection afterwards.
//
// Authorization: every read and every state transition is scoped to the
// caller's (tenant, actor). A transaction id from another tenant behaves exactly
// like an unknown id. Approval is bound to a SHA-256 of the exact plan (title,
// intent, actions, payloads): changing the plan after approval invalidates it.
// High-impact plans need two distinct approvers, neither of them the maker, and
// execution is claimed atomically so two workers cannot run the same plan.
import { createHash, randomUUID } from "node:crypto";
import { getDb } from "@/lib/db";

export interface PlannedAction {
  kind: string;
  target: string;
  payload: Record<string, unknown>;
  // Human-readable expected effect shown in the approval card.
  expected?: string;
}

export interface RegisteredAction {
  // Simulate computes the effect without committing anything.
  simulate?: (payload: Record<string, unknown>) => Promise<unknown>;
  // Execute performs the real operation and returns a result.
  execute: (payload: Record<string, unknown>) => Promise<unknown>;
  // Undo rolls a specific execution back; receives the payload + execute result.
  undo?: (payload: Record<string, unknown>, result: unknown) => Promise<void>;
  // Verify checks the external system actually reflects the change.
  verify?: (payload: Record<string, unknown>, result: unknown) => Promise<boolean>;
  // Destructive actions cannot be truly undone; they require explicit approval text.
  irreversible?: boolean;
}

export function registerActionType(kind: string, impl: RegisteredAction) {
  actionTypes.set(kind, impl);
}
const actionTypes = new Map<string, RegisteredAction>();

export function listActionTypes(): string[] {
  return [...actionTypes.keys()];
}

export interface TxAction extends PlannedAction {
  id: string;
  seq: number;
  status: "pending" | "executed" | "failed" | "compensated" | "skipped";
}

export interface Transaction {
  id: string;
  org: string;
  title: string;
  intent: string;
  created_by: string | null;
  approved_by: string | null;
  second_approved_by: string | null;
  plan_hash: string | null;
  approved_hash: string | null;
  requires_second_approval: boolean;
  status:
    | "planned" | "simulated" | "awaiting_approval" | "executing"
    | "verifying" | "done" | "failed" | "compensated" | "rejected";
  actions: TxAction[];
  simulation: unknown;
  verification: unknown;
  created_at: string;
}

/** Who is acting, in which tenant. Both parts are required. */
export interface TxScope {
  tenant: string;
  actor: string;
}

function normaliseScope(scope: TxScope): TxScope {
  const tenant = scope.tenant?.trim();
  const actor = scope.actor?.trim();
  if (!tenant || !actor) throw new Error("A transaction scope needs a tenant and an actor.");
  return { tenant, actor };
}

/** Recursive key-sorted JSON, so the same plan always hashes the same. */
function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
}

/** SHA-256 over exactly what a human approves. */
export function planHash(title: string, intent: string, actions: PlannedAction[]): string {
  const body = canonical({
    title,
    intent,
    actions: actions.map((a) => ({
      kind: a.kind,
      target: a.target,
      payload: a.payload ?? {},
      expected: a.expected ?? null,
    })),
  });
  return createHash("sha256").update(body).digest("hex");
}

// Kinds whose effect is not an ordinary reversible write. Anything registered
// `irreversible`, or a kind naming a destructive verb, needs a second approver.
const HIGH_IMPACT_KIND = /(^|[._:-])(delete|destroy|remove|drop|purge|void|terminate|refund|payment|payout|transfer|grant|revoke|admin)([._:-]|$)/i;

export function requiresDualApproval(actions: PlannedAction[]): boolean {
  return actions.some((a) => {
    const impl = actionTypes.get(a.kind);
    return impl?.irreversible === true || HIGH_IMPACT_KIND.test(a.kind);
  });
}

function rowToTx(row: Record<string, unknown>): Transaction {
  const actionRows = getDb()
    .prepare("SELECT * FROM transaction_actions WHERE transaction_id = ? ORDER BY seq")
    .all(String(row.id)) as Record<string, unknown>[];
  const actions: TxAction[] = actionRows.map((a) => ({
    id: String(a.id),
    seq: Number(a.seq),
    kind: String(a.kind),
    target: String(a.target),
    payload: JSON.parse(String(a.payload)),
    expected: (a.expected as string | null) ?? undefined,
    status: a.status as TxAction["status"],
  }));
  return {
    id: String(row.id),
    org: String(row.org),
    title: String(row.title),
    intent: String(row.intent),
    created_by: (row.created_by as string | null) ?? null,
    approved_by: (row.approved_by as string | null) ?? null,
    second_approved_by: (row.second_approved_by as string | null) ?? null,
    plan_hash: (row.plan_hash as string | null) ?? null,
    approved_hash: (row.approved_hash as string | null) ?? null,
    requires_second_approval: requiresDualApproval(actions),
    status: row.status as Transaction["status"],
    simulation: row.simulation ? JSON.parse(String(row.simulation)) : null,
    verification: row.verification ? JSON.parse(String(row.verification)) : null,
    created_at: String(row.created_at),
    actions,
  };
}

export function planTransaction(
  scope: TxScope,
  title: string,
  intent: string,
  actions: PlannedAction[],
): Transaction {
  const who = normaliseScope(scope);
  const db = getDb();
  const id = randomUUID();
  db.prepare(
    "INSERT INTO transactions (id, org, title, intent, status, plan, plan_hash, created_by) VALUES (?, ?, ?, ?, 'planned', ?, ?, ?)",
  ).run(id, who.tenant, title, intent, JSON.stringify(actions), planHash(title, intent, actions), who.actor);
  const ins = db.prepare(
    "INSERT INTO transaction_actions (id, transaction_id, seq, kind, target, payload, expected) VALUES (?, ?, ?, ?, ?, ?, ?)",
  );
  actions.forEach((a, i) =>
    ins.run(randomUUID(), id, i, a.kind, a.target, JSON.stringify(a.payload ?? {}), a.expected ?? null),
  );
  return getTransaction(who, id)!;
}

/** Scoped read: an id in another tenant is indistinguishable from a missing one. */
export function getTransaction(scope: TxScope, id: string): Transaction | null {
  const who = normaliseScope(scope);
  const row = getDb()
    .prepare("SELECT * FROM transactions WHERE id = ? AND org = ?")
    .get(id, who.tenant) as Record<string, unknown> | undefined;
  return row ? rowToTx(row) : null;
}

export function listTransactions(scope: TxScope, limit = 50): Transaction[] {
  const who = normaliseScope(scope);
  return (
    getDb()
      .prepare("SELECT * FROM transactions WHERE org = ? ORDER BY created_at DESC LIMIT ?")
      .all(who.tenant, limit) as Record<string, unknown>[]
  ).map(rowToTx);
}

export function replay(txId: string, kind: string, data: unknown) {
  getDb()
    .prepare("INSERT INTO agent_replay (run_id, seq, kind, data) VALUES (?, ?, ?, ?)")
    .run(txId, nextSeq(txId), kind, JSON.stringify(data ?? null));
}
function nextSeq(txId: string): number {
  const row = getDb()
    .prepare("SELECT COALESCE(MAX(seq), -1) + 1 AS s FROM agent_replay WHERE run_id = ?")
    .get(txId) as { s: number };
  return Number(row.s);
}
export function getReplay(scope: TxScope, txId: string) {
  const who = normaliseScope(scope);
  const owned = getDb()
    .prepare("SELECT 1 FROM transactions WHERE id = ? AND org = ?")
    .get(txId, who.tenant);
  if (!owned) return [];
  return (
    getDb()
      .prepare("SELECT seq, at, kind, data FROM agent_replay WHERE run_id = ? ORDER BY seq")
      .all(txId) as Record<string, unknown>[]
  ).map((r) => ({
    seq: Number(r.seq),
    at: String(r.at),
    kind: String(r.kind),
    data: JSON.parse(String(r.data)),
  }));
}

/** The stored plan still hashes to its immutable plan_hash. */
function assertPlanIntact(tx: Transaction): void {
  const current = planHash(tx.title, tx.intent, tx.actions);
  if (!tx.plan_hash || current !== tx.plan_hash) {
    throw new Error("Transaction plan was modified after it was recorded; re-plan it.");
  }
}

// Simulate: run every action's simulate() (or fall back to its expected text)
// without committing. Moves the transaction to awaiting_approval.
export async function simulate(scope: TxScope, id: string): Promise<Transaction> {
  const tx = getTransaction(scope, id);
  if (!tx) throw new Error("Unknown transaction.");
  if (!["planned", "simulated", "awaiting_approval"].includes(tx.status)) {
    throw new Error(`Cannot simulate a transaction in status ${tx.status}.`);
  }
  assertPlanIntact(tx);
  const effects: unknown[] = [];
  for (const a of tx.actions) {
    const impl = actionTypes.get(a.kind);
    if (!impl) throw new Error(`No implementation registered for action kind "${a.kind}".`);
    const effect = impl.simulate
      ? await impl.simulate(a.payload)
      : { expected: a.expected ?? "no simulation registered" };
    effects.push({ action: a.id, kind: a.kind, target: a.target, effect });
    replay(id, "simulate", { action: a.id, kind: a.kind, effect });
  }
  getDb()
    .prepare("UPDATE transactions SET status='awaiting_approval', simulation=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=? AND org=?")
    .run(JSON.stringify(effects), id, normaliseScope(scope).tenant);
  return getTransaction(scope, id)!;
}

// Approve / reject. Only a transaction in awaiting_approval can be approved.
// Separation of duties: the maker can never approve its own plan, a high-impact
// plan needs two distinct approvers, and each approval is bound to the plan hash
// that was actually on screen.
export function approve(scope: TxScope, id: string, approved: boolean): Transaction {
  const who = normaliseScope(scope);
  const tx = getTransaction(who, id);
  if (!tx) throw new Error("Unknown transaction.");
  if (tx.status !== "awaiting_approval") {
    throw new Error(`Cannot ${approved ? "approve" : "reject"} a transaction in status ${tx.status}.`);
  }
  assertPlanIntact(tx);
  const same = (a: string | null, b: string | null) =>
    Boolean(a && b && a.trim().toLowerCase() === b.trim().toLowerCase());
  if (same(who.actor, tx.created_by)) {
    throw new Error("Separation of duties: the maker of a transaction cannot approve it.");
  }

  const db = getDb();
  if (!approved) {
    const changes = db
      .prepare("UPDATE transactions SET status='rejected', approved_by=?, approved_hash=NULL, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=? AND org=? AND status='awaiting_approval'")
      .run(who.actor, id, who.tenant).changes;
    if (Number(changes) !== 1) throw new Error("Transaction changed while it was being reviewed.");
    replay(id, "rejected", { approver: who.actor });
    return getTransaction(who, id)!;
  }

  const hash = tx.plan_hash!;
  if (!tx.approved_by) {
    const changes = db
      .prepare("UPDATE transactions SET approved_by=?, approved_hash=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=? AND org=? AND status='awaiting_approval' AND approved_by IS NULL")
      .run(who.actor, hash, id, who.tenant).changes;
    if (Number(changes) !== 1) throw new Error("Transaction changed while it was being reviewed.");
    replay(id, "approved", { approver: who.actor, hash, second: tx.requires_second_approval });
    // A high-impact plan waits for a second, different approver.
    if (tx.requires_second_approval) return getTransaction(who, id)!;
    db.prepare("UPDATE transactions SET status='executing', updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=? AND org=?").run(id, who.tenant);
    return getTransaction(who, id)!;
  }

  if (!tx.requires_second_approval) throw new Error("This transaction is already approved.");
  if (same(who.actor, tx.approved_by) || same(who.actor, tx.created_by)) {
    throw new Error("Dual approval needs a second approver who is not the maker or the first approver.");
  }
  const changes = db
    .prepare("UPDATE transactions SET second_approved_by=?, second_approved_hash=?, status='executing', updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=? AND org=? AND status='awaiting_approval' AND second_approved_by IS NULL")
    .run(who.actor, hash, id, who.tenant).changes;
  if (Number(changes) !== 1) throw new Error("Transaction changed while it was being reviewed.");
  replay(id, "approved_second", { approver: who.actor, hash });
  return getTransaction(who, id)!;
}

// Long enough for a slow connector call, short enough that a crashed worker does
// not block a plan forever.
const LEASE_MS = 5 * 60_000;

/** Atomically take the execution lease; false when someone else holds it. */
function claimExecution(tenant: string, id: string, holder: string): boolean {
  const staleBefore = new Date(Date.now() - LEASE_MS).toISOString();
  const changes = getDb()
    .prepare(
      "UPDATE transactions SET execution_lease=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=? AND org=? AND status='executing' AND (execution_lease IS NULL OR execution_lease < ?)",
    )
    .run(holder, id, tenant, staleBefore).changes;
  return Number(changes) === 1;
}

function releaseExecution(tenant: string, id: string, holder: string): void {
  getDb()
    .prepare("UPDATE transactions SET execution_lease=NULL WHERE id=? AND org=? AND execution_lease=?")
    .run(id, tenant, holder);
}

// Execute approved actions in order, verifying each; on failure, compensate
// everything already executed in reverse order.
export async function execute(scope: TxScope, id: string): Promise<Transaction> {
  const who = normaliseScope(scope);
  let tx = getTransaction(who, id);
  if (!tx) throw new Error("Unknown transaction.");
  if (tx.status !== "executing") throw new Error(`Transaction is ${tx.status}, not executing. Call approve() first.`);
  assertPlanIntact(tx);
  // The approval must cover exactly this plan: a plan edited after approval
  // carries a different hash and cannot run on the old signature.
  if (!tx.approved_hash || tx.approved_hash !== tx.plan_hash) {
    throw new Error("Approval does not cover the current plan; re-approve it.");
  }
  if (tx.requires_second_approval && (!tx.second_approved_by || tx.second_approved_by === tx.approved_by)) {
    throw new Error("Dual approval is required before this transaction can execute.");
  }
  const holder = `${who.actor}:${randomUUID()}`;
  if (!claimExecution(who.tenant, id, holder)) {
    throw new Error("Transaction is already being executed by another worker.");
  }
  try {
    const db = getDb();
    const executed: { a: TxAction; result: unknown }[] = [];
    for (const a of tx.actions) {
      if (a.status === "executed") continue;
      const impl = actionTypes.get(a.kind);
      if (!impl) throw new Error(`No implementation registered for action kind "${a.kind}".`);
      try {
        const result = await impl.execute(a.payload);
        executed.push({ a, result });
        db.prepare("UPDATE transaction_actions SET status='executed', executed_result=?, executed_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?")
          .run(JSON.stringify(result ?? null), a.id);
        replay(id, "execute", { action: a.id, kind: a.kind, result });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        db.prepare("UPDATE transaction_actions SET status='failed' WHERE id=?").run(a.id);
        replay(id, "execute_failed", { action: a.id, error: message });
        await compensate(who, id);
        db.prepare("UPDATE transactions SET status='failed', updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=? AND org=?").run(id, who.tenant);
        return getTransaction(who, id)!;
      }
    }
    // Verification pass.
    const checks: { action: string; ok: boolean }[] = [];
    for (const { a, result } of executed) {
      const impl = actionTypes.get(a.kind);
      const ok = impl?.verify ? await impl.verify(a.payload, result) : true;
      checks.push({ action: a.id, ok });
      replay(id, "verify", { action: a.id, ok });
    }
    const allOk = checks.every((c) => c.ok);
    db.prepare("UPDATE transactions SET status=?, verification=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=? AND org=?")
      .run(allOk ? "done" : "verifying", JSON.stringify(checks), id, who.tenant);
    return getTransaction(who, id)!;
  } finally {
    releaseExecution(who.tenant, id, holder);
  }
}

// Compensation: undo executed actions in reverse order. Best-effort per action;
// actions without an undo are marked skipped (they were flagged irreversible).
export async function compensate(scope: TxScope, id: string): Promise<Transaction> {
  const who = normaliseScope(scope);
  const tx = getTransaction(who, id);
  if (!tx) throw new Error("Unknown transaction.");
  if (!["executing", "verifying", "done", "failed"].includes(tx.status)) {
    throw new Error(`Cannot compensate a transaction in status ${tx.status}.`);
  }
  assertPlanIntact(tx);
  const executed = tx.actions.filter((a) => a.status === "executed").reverse();
  for (const a of executed) {
    const impl = actionTypes.get(a.kind);
    let result: unknown = null;
    try {
      result = JSON.parse(
        String(
          (getDb().prepare("SELECT executed_result FROM transaction_actions WHERE id=?").get(a.id) as { executed_result: string | null }).executed_result ?? "null",
        ),
      );
    } catch {
      // keep null result
    }
    if (!impl?.undo) {
      getDb().prepare("UPDATE transaction_actions SET status='skipped' WHERE id=?").run(a.id);
      replay(id, "compensate_skipped", { action: a.id, reason: "no undo registered" });
      continue;
    }
    try {
      await impl.undo(a.payload, result);
      getDb().prepare("UPDATE transaction_actions SET status='compensated' WHERE id=?").run(a.id);
      replay(id, "compensate", { action: a.id });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      replay(id, "compensate_failed", { action: a.id, error: message });
    }
  }
  getDb()
    .prepare("UPDATE transactions SET status='compensated', execution_lease=NULL, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=? AND org=?")
    .run(id, who.tenant);
  return getTransaction(who, id)!;
}
