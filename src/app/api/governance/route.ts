// Governance API: audit trail, capability grants, connector health and durable
// run recovery in one place for admins.
import { z } from "zod";
import { guard, audit, auditStrict, listAudit, isAdmin, capabilitySubject } from "@/lib/guard";
import { getCapability, listCapabilities, grantCapability, revokeCapability, purgeExpired } from "@/lib/capability";
import { principalForSession } from "@/lib/rbac";
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
  const who = principalForSession(gate);
  const tenant = who.tenant;
  const admin = isAdmin(gate);
  // Separate privileges: the audit trail, durable-run inputs and security
  // reports are admin-only; a non-admin sees only their own capability grants.
  // Everything is filtered by tenant inside the query, not in the client.
  return Response.json({
    audit: admin ? listAudit(100, tenant) : [],
    capabilities: admin
      ? listCapabilities(undefined, 100, tenant)
      : listCapabilities(capabilitySubject(gate), 100, tenant),
    runs: admin ? listRuns(50, tenant) : [],
    verifications: admin ? listReports(25, tenant) : [],
    recovery: admin ? recoverySweep() : { requeued: 0, dead: 0 },
    admin,
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
  const tenant = principalForSession(gate).tenant;
  switch (body.op) {
    case "grant": {
      // A grant may only target a principal inside the caller's own tenant:
      // the subject is "tenant|user", so a foreign prefix is a cross-tenant
      // capability injection and is refused.
      if (!body.subject.startsWith(`${tenant}|`)) {
        return bad("A capability can only be granted inside your own tenant.");
      }
      auditStrict(req, gate, "capability.grant", body.subject, { scope: `${body.connector}:${body.action}`, ttl: body.ttlSeconds ?? 300 });
      const cap = grantCapability({ ...body, issuedBy: gate.email, org: tenant });
      return Response.json({ capability: cap });
    }
    case "revoke": {
      const existing = getCapability(body.id);
      if (!existing || existing.org !== tenant) {
        return Response.json({ error: { message: "Capability not found." } }, { status: 404 });
      }
      auditStrict(req, gate, "capability.revoke", body.id, { subject: existing.subject });
      const ok = revokeCapability(body.id);
      return Response.json({ ok });
    }
    case "replay": {
      auditStrict(req, gate, "run.replay", body.id, {});
      const ok = replayRun(body.id, tenant);
      audit(req, gate, "run.replayed", body.id, { ok });
      return Response.json({ ok });
    }
    case "purge": {
      auditStrict(req, gate, "capability.purge", "capabilities", {});
      const n = purgeExpired();
      audit(req, gate, "capability.purged", "capabilities", { removed: n });
      return Response.json({ removed: n });
    }
    case "audit-checkpoint": {
      // Signed outside the database, then shipped to the configured sink so a
      // database rewrite cannot silently rewrite history as well.
      try {
        const result = createCheckpoint(tenant);
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
      const verdict = verifyCheckpoints(tenant);
      audit(req, gate, "audit.verify", "audit_log", verdict);
      return Response.json({ verdict, checkpoints: listCheckpoints(tenant, 20) });
    }
  }
}
