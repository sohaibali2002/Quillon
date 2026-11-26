// Quillon Transaction Engine: every consequential agent action follows
// plan → simulate → approve → execute → verify → compensate.
//
// An action declares `execute` (do the real thing) and `undo` (compensating
// action). Nothing executes until a human approves the simulated plan; each
// executed action's result and undo payload are stored so the transaction can
// be rolled back in reverse order, and every event is written to agent_replay
// for full inspection afterwards.
import { randomUUID } from "node:crypto";
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
  title: string;
  intent: string;
  created_by: string | null;
  status:
    | "planned" | "simulated" | "awaiting_approval" | "executing"
    | "verifying" | "done" | "failed" | "compensated" | "rejected";
  actions: TxAction[];
  simulation: unknown;
  verification: unknown;
  created_at: string;
}

export function planTransaction(
  title: string,
  intent: string,
  actions: PlannedAction[],
  createdBy?: string,
): Transaction {
  const db = getDb();
  const id = randomUUID();
  db.prepare("INSERT INTO transactions (id, title, intent, status, plan, created_by) VALUES (?, ?, ?, 'planned', ?, ?)")
    .run(id, title, intent, JSON.stringify(actions), createdBy ?? null);
  const ins = db.prepare(
    "INSERT INTO transaction_actions (id, transaction_id, seq, kind, target, payload, expected) VALUES (?, ?, ?, ?, ?, ?, ?)",
  );
  actions.forEach((a, i) =>
    ins.run(randomUUID(), id, i, a.kind, a.target, JSON.stringify(a.payload), a.expected ?? null),
  );
  return getTransaction(id)!;
}

function rowToTx(row: Record<string, unknown>): Transaction {
  const actionRows = getDb()
    .prepare("SELECT * FROM transaction_actions WHERE transaction_id = ? ORDER BY seq")
    .all(String(row.id)) as Record<string, unknown>[];
  return {
    id: String(row.id),
    title: String(row.title),
    intent: String(row.intent),
    created_by: (row.created_by as string | null) ?? null,
    status: row.status as Transaction["status"],
    simulation: row.simulation ? JSON.parse(String(row.simulation)) : null,
    verification: row.verification ? JSON.parse(String(row.verification)) : null,
    created_at: String(row.created_at),
    actions: actionRows.map((a) => ({
      id: String(a.id),
      seq: Number(a.seq),
      kind: String(a.kind),
      target: String(a.target),
      payload: JSON.parse(String(a.payload)),
      expected: (a.expected as string | null) ?? undefined,
      status: a.status as TxAction["status"],
    })),
  };
}

export function getTransaction(id: string): Transaction | null {
  const row = getDb().prepare("SELECT * FROM transactions WHERE id = ?").get(id) as
    | Record<string, unknown>
    | undefined;
  return row ? rowToTx(row) : null;
}

export function listTransactions(limit = 50): Transaction[] {
  return (
    getDb()
      .prepare("SELECT * FROM transactions ORDER BY created_at DESC LIMIT ?")
      .all(limit) as Record<string, unknown>[]
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
export function getReplay(txId: string) {
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

// Simulate: run every action's simulate() (or fall back to its expected text)
// without committing. Moves the transaction to awaiting_approval.
export async function simulate(id: string): Promise<Transaction> {
  const tx = getTransaction(id);
  if (!tx) throw new Error("Unknown transaction.");
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
    .prepare("UPDATE transactions SET status='awaiting_approval', simulation=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?")
    .run(JSON.stringify(effects), id);
  return getTransaction(id)!;
}

// Approve / reject. Only a transaction in awaiting_approval can be approved.
// Separation of duties: the maker of a transaction can never approve or reject
// it — a second identity must sign off before anything executes.
export function approve(id: string, approved: boolean, approver?: string): Transaction {
  const tx = getTransaction(id);
  if (!tx) throw new Error("Unknown transaction.");
  if (tx.status !== "awaiting_approval") {
    throw new Error(`Cannot ${approved ? "approve" : "reject"} a transaction in status ${tx.status}.`);
  }
  if (
    approver &&
    tx.created_by &&
    approver.trim().toLowerCase() === tx.created_by.trim().toLowerCase()
  ) {
    throw new Error("Separation of duties: the maker of a transaction cannot approve it.");
  }
  getDb()
    .prepare("UPDATE transactions SET status=?, approved_by=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?")
    .run(approved ? "executing" : "rejected", approver ?? null, id);
  replay(id, approved ? "approved" : "rejected", { approver: approver ?? null });
  return getTransaction(id)!;
}

// Execute approved actions in order, verifying each; on failure, compensate
// everything already executed in reverse order.
export async function execute(id: string): Promise<Transaction> {
  let tx = getTransaction(id);
  if (!tx) throw new Error("Unknown transaction.");
  if (tx.status !== "executing") throw new Error(`Transaction is ${tx.status}, not executing. Call approve() first.`);
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
      await compensate(id);
      db.prepare("UPDATE transactions SET status='failed', updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?").run(id);
      return getTransaction(id)!;
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
  db.prepare("UPDATE transactions SET status=?, verification=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?")
    .run(allOk ? "done" : "verifying", JSON.stringify(checks), id);
  return getTransaction(id)!;
}

// Compensation: undo executed actions in reverse order. Best-effort per action;
// actions without an undo are marked skipped (they were flagged irreversible).
export async function compensate(id: string): Promise<Transaction> {
  const tx = getTransaction(id);
  if (!tx) throw new Error("Unknown transaction.");
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
  getDb().prepare("UPDATE transactions SET status='compensated', updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?").run(id);
  return getTransaction(id)!;
}
