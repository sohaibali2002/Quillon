// Governance API: audit trail, capability grants, connector health and durable
// run recovery in one place for admins.
import { z } from "zod";
import { guard, audit, listAudit, isAdmin } from "@/lib/guard";
import { listCapabilities, grantCapability, revokeCapability, purgeExpired } from "@/lib/capability";
import { listRuns, replayRun, recoverySweep } from "@/lib/durable";
import { listReports } from "@/lib/verify";
import {
  AuditKeyMissingError,
  createCheckpoint,
  exportCheckpoint,
  listCheckpoints,
  verifyCheckpoints,
} from "@/lib/audit-checkpoint";

export const maxDuration = 30;

function bad(message: string, issues?: unknown) {
  return Response.json({ error: { message, ...(issues ? { issues } : {}) } }, { status: 400 });
}

export async function GET(req: Request) {
  const gate = await guard(req, { role: "viewer" });
  if (gate instanceof Response) return gate;
  const url = new URL(req.url);
  return Response.json({
    audit: listAudit(100),
    capabilities: listCapabilities(undefined, 100),
    runs: listRuns(50),
    verifications: listReports(25),
    recovery: recoverySweep(),
    admin: isAdmin(gate),
  });
}

const grantSchema = z.object({
  op: z.literal("grant"),
  subject: z.string().trim().min(1),
  connector: z.string().trim().min(1),
  action: z.string().trim().min(1),
  resource: z.string().trim().min(1).nullable().optional(),
  ttlSeconds: z.number().int().min(10).max(86400).optional(),
  maxUses: z.number().int().min(1).max(10000).nullable().optional(),
});

const schema = z.discriminatedUnion("op", [
  grantSchema,
  z.object({ op: z.literal("revoke"), id: z.string().trim().min(1) }),
  z.object({ op: z.literal("replay"), id: z.string().trim().min(1) }),
  z.object({ op: z.literal("purge") }),
  z.object({ op: z.literal("audit-checkpoint") }),
  z.object({ op: z.literal("audit-verify") }),
]);

export async function POST(req: Request) {
  const gate = await guard(req, { role: "admin" });
  if (gate instanceof Response) return gate;
  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return bad("Invalid governance operation.", parsed.error.issues);
  const body = parsed.data;
  switch (body.op) {
    case "grant": {
      const cap = grantCapability({ ...body, issuedBy: gate.email });
      audit(req, gate, "capability.grant", cap.id, { scope: cap.scope, ttl: body.ttlSeconds ?? 300 });
      return Response.json({ capability: cap });
    }
    case "revoke": {
      const ok = revokeCapability(body.id);
      audit(req, gate, "capability.revoke", body.id, { ok });
      return Response.json({ ok });
    }
    case "replay": {
      const ok = replayRun(body.id);
      audit(req, gate, "run.replay", body.id, { ok });
      return Response.json({ ok });
    }
    case "purge": {
      const n = purgeExpired();
      audit(req, gate, "capability.purge", "capabilities", { removed: n });
      return Response.json({ removed: n });
    }
    case "audit-checkpoint": {
      // Signed outside the database, then shipped to the configured sink so a
      // database rewrite cannot silently rewrite history as well.
      try {
        const result = createCheckpoint();
        let exported: { exported: boolean; detail: string } = { exported: false, detail: "Nothing new to sign." };
        if (result.checkpoint) {
          audit(req, gate, "audit.checkpoint", String(result.checkpoint.seq), {
            head: result.checkpoint.headHash,
          });
          exported = await exportCheckpoint(result.checkpoint);
          if (!exported.exported) {
            return Response.json(
              { checkpoint: result.checkpoint, exported, warning: exported.detail },
              { status: 200 },
            );
          }
        }
        return Response.json({ checkpoint: result.checkpoint ?? null, exported });
      } catch (err) {
        if (err instanceof AuditKeyMissingError) {
          return Response.json({ error: { message: err.message } }, { status: 503 });
        }
        throw err;
      }
    }
    case "audit-verify": {
      const verdict = verifyCheckpoints();
      audit(req, gate, "audit.verify", "audit_log", verdict);
      return Response.json({ verdict, checkpoints: listCheckpoints(undefined, 20) });
    }
  }
}
