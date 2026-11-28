// Quillon Transaction Engine API: plan → simulate → approve → execute → verify →
// compensate, with full replay inspection. Approve/execute/compensate are
// state-changing and audited.
//
// Every request is scoped to the caller's tenant before any row is read, and
// state-changing ops write a fail-closed audit record first: if the record
// cannot be written the action is refused.
import { z } from "zod";
import { guard, audit, auditStrict, capabilitySubject } from "@/lib/guard";
import { enforceRateLimit } from "@/lib/rate-limit";
import { principalForSession } from "@/lib/rbac";
import {
  planTransaction, simulate, approve, execute, compensate,
  getTransaction, listTransactions, getReplay, type TxScope,
} from "@/lib/transaction";

export const maxDuration = 60;

const planSchema = z.object({
  op: z.literal("plan"),
  title: z.string().trim().min(1).max(200),
  intent: z.string().trim().min(1).max(2000),
  actions: z.array(z.object({
    kind: z.string().trim().min(1).max(80),
    target: z.string().trim().min(1).max(200),
    payload: z.record(z.string(), z.unknown()).default({}),
    expected: z.string().max(500).optional(),
  })).min(1).max(50),
});

const id = z.string().trim().min(1).max(80);

const schema = z.discriminatedUnion("op", [
  planSchema,
  z.object({ op: z.literal("simulate"), id }),
  z.object({ op: z.literal("approve"), id, approved: z.boolean() }),
  z.object({ op: z.literal("execute"), id }),
  z.object({ op: z.literal("compensate"), id }),
  z.object({ op: z.literal("replay"), id }),
]);

export async function GET(req: Request) {
  const gate = await guard(req);
  if (gate instanceof Response) return gate;
  const who = principalForSession(gate);
  const scope: TxScope = { tenant: who.tenant, actor: who.owner };
  const txId = new URL(req.url).searchParams.get("id");
  if (txId) {
    const tx = getTransaction(scope, txId);
    if (!tx) return Response.json({ error: { message: "Unknown transaction." } }, { status: 404 });
    return Response.json({ transaction: tx, replay: getReplay(scope, txId) });
  }
  return Response.json({ transactions: listTransactions(scope, 50) });
}

export async function POST(req: Request) {
  const gate = await guard(req, { role: "member" });
  if (gate instanceof Response) return gate;
  const limited = enforceRateLimit(capabilitySubject(gate), "transactions", 30, 60_000);
  if (limited) return limited;
  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return Response.json({ error: { message: "Invalid transaction operation." } }, { status: 400 });
  }
  const body = parsed.data;
  const who = principalForSession(gate);
  // Open mode (local dev only, never production) has no second human, so the
  // built-in operator label stands in as the approver and the maker is "open".
  const maker: TxScope = { tenant: who.tenant, actor: who.owner, roles: gate.roles };
  const approver: TxScope = {
    tenant: who.tenant,
    actor: gate.sub === "open" ? "open-mode-operator" : who.owner,
    roles: gate.roles,
  };
  try {
    switch (body.op) {
      case "plan": {
        auditStrict(req, gate, "transaction.plan", "pending", { title: body.title, actions: body.actions.length });
        const tx = planTransaction(maker, body.title, body.intent, body.actions);
        audit(req, gate, "transaction.planned", tx.id, { hash: tx.plan_hash });
        return Response.json({ transaction: await simulate(maker, tx.id) });
      }
      case "simulate":
        return Response.json({ transaction: await simulate(maker, body.id) });
      case "approve": {
        auditStrict(req, gate, body.approved ? "transaction.approve" : "transaction.reject", body.id, {
          actor: approver.actor,
        });
        const tx = approve(approver, body.id, body.approved);
        audit(req, gate, "transaction.approved", body.id, {
          status: tx.status,
          hash: tx.approved_hash,
          first: tx.approved_by,
          second: tx.second_approved_by,
        });
        return Response.json({ transaction: tx });
      }
      case "execute": {
        auditStrict(req, gate, "transaction.execute", body.id, { actor: maker.actor });
        const tx = await execute(maker, body.id);
        audit(req, gate, "transaction.executed", body.id, { status: tx.status });
        return Response.json({ transaction: tx });
      }
      case "compensate": {
        auditStrict(req, gate, "transaction.compensate", body.id, { actor: maker.actor });
        const tx = await compensate(maker, body.id);
        audit(req, gate, "transaction.compensated", body.id);
        return Response.json({ transaction: tx });
      }
      case "replay":
        return Response.json({ replay: getReplay(maker, body.id) });
    }
  } catch (err) {
    return Response.json(
      { error: { message: err instanceof Error ? err.message : "Transaction operation failed." } },
      { status: 409 },
    );
  }
}
