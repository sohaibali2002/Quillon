// Quillon Transaction Engine API: plan → simulate → approve → execute → verify →
// compensate, with full replay inspection. Approve/execute/compensate are
// state-changing and audited.
import { z } from "zod";
import { guard, audit } from "@/lib/guard";
import {
  planTransaction, simulate, approve, execute, compensate,
  getTransaction, listTransactions, getReplay,
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

const schema = z.discriminatedUnion("op", [
  planSchema,
  z.object({ op: z.literal("simulate"), id: z.string() }),
  z.object({ op: z.literal("approve"), id: z.string(), approved: z.boolean() }),
  z.object({ op: z.literal("execute"), id: z.string() }),
  z.object({ op: z.literal("compensate"), id: z.string() }),
  z.object({ op: z.literal("replay"), id: z.string() }),
]);

export async function GET(req: Request) {
  const gate = await guard(req);
  if (gate instanceof Response) return gate;
  const id = new URL(req.url).searchParams.get("id");
  if (id) {
    const tx = getTransaction(id);
    if (!tx) return Response.json({ error: { message: "Unknown transaction." } }, { status: 404 });
    return Response.json({ transaction: tx, replay: getReplay(id) });
  }
  return Response.json({ transactions: listTransactions(50) });
}

export async function POST(req: Request) {
  const gate = await guard(req, { role: "member" });
  if (gate instanceof Response) return gate;
  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return Response.json({ error: { message: "Invalid transaction operation." } }, { status: 400 });
  }
  const body = parsed.data;
  try {
    switch (body.op) {
      case "plan": {
        const tx = planTransaction(body.title, body.intent, body.actions, gate.email);
        audit(req, gate, "transaction.plan", tx.id, { title: tx.title, actions: body.actions.length });
        return Response.json({ transaction: await simulate(tx.id) });
      }
      case "simulate":
        return Response.json({ transaction: await simulate(body.id) });
      case "approve": {
        const tx = approve(body.id, body.approved);
        audit(req, gate, body.approved ? "transaction.approve" : "transaction.reject", body.id);
        return Response.json({ transaction: tx });
      }
      case "execute": {
        const tx = await execute(body.id);
        audit(req, gate, "transaction.execute", body.id, { status: tx.status });
        return Response.json({ transaction: tx });
      }
      case "compensate": {
        const tx = await compensate(body.id);
        audit(req, gate, "transaction.compensate", body.id);
        return Response.json({ transaction: tx });
      }
      case "replay":
        return Response.json({ replay: getReplay(body.id) });
    }
  } catch (err) {
    return Response.json(
      { error: { message: err instanceof Error ? err.message : "Transaction operation failed." } },
      { status: 409 },
    );
  }
}
