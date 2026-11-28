// Durable execution worker + queue API. POST { op: "tick" } claims and runs the
// next runnable run (used by cron, unattended jobs and tests); GET lists runs.
import { z } from "zod";
import { guard, audit } from "@/lib/guard";
import { principalForSession } from "@/lib/rbac";
import { listRuns, tick, replayRun, recoverySweep } from "@/lib/durable";

export const maxDuration = 60;

export async function GET(req: Request) {
  const gate = await guard(req);
  if (gate instanceof Response) return gate;
  const tenant = principalForSession(gate).tenant;
  return Response.json({ runs: listRuns(50, tenant), recovery: recoverySweep() });
}

const schema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("tick") }),
  z.object({ op: z.literal("replay"), id: z.string().min(1) }),
]);

export async function POST(req: Request) {
  const gate = await guard(req, { role: "member" });
  if (gate instanceof Response) return gate;
  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return Response.json({ error: { message: "Invalid worker operation." } }, { status: 400 });
  }
  if (parsed.data.op === "replay") {
    const ok = replayRun(parsed.data.id, principalForSession(gate).tenant);
    audit(req, gate, "run.replay", parsed.data.id, { ok });
    return Response.json({ ok });
  }
  const id = await tick();
  return Response.json({ ran: id });
}
