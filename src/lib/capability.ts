// Quillon Capability Security: agents never act on raw connector credentials.
// Before a task runs, the platform mints short-lived, narrowly scoped
// capabilities ("read account X", "draft email", "no send"). Enforcement lives
// here — outside the LLM — and every connector tool call is checked against the
// grant's action, resource and expiry before the connector SDK is touched.
import { randomUUID } from "node:crypto";
import { getDb } from "@/lib/db";

export interface Capability {
  id: string;
  org: string;
  subject: string;
  connector: string;
  action: string;
  resource: string | null;
  scope: string;
  expires_at: string;
  used_count: number;
  max_uses: number | null;
}

export function grantCapability(opts: {
  subject: string;
  connector: string;
  action: string;
  resource?: string | null;
  ttlSeconds?: number;
  maxUses?: number | null;
  issuedBy?: string;
  org?: string;
}): Capability {
  const db = getDb();
  const ttl = opts.ttlSeconds ?? 300;
  const expires = new Date(Date.now() + ttl * 1000).toISOString();
  const id = randomUUID();
  const scope = `${opts.connector}:${opts.action}${opts.resource ? `#${opts.resource}` : ""}`;
  db.prepare(
    "INSERT INTO capabilities (id, org, subject, connector, action, resource, scope, issued_by, expires_at, max_uses) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(id, opts.org?.trim() || "default", opts.subject, opts.connector, opts.action, opts.resource ?? null, scope, opts.issuedBy ?? null, expires, opts.maxUses ?? null);
  return getCapability(id)!;
}

export function getCapability(id: string): Capability | null {
  const row = getDb().prepare("SELECT * FROM capabilities WHERE id = ?").get(id) as
    | Record<string, unknown>
    | undefined;
  return row ? rowToCap(row) : null;
}

/**
 * Grants visible to a tenant. Without an org this returns nothing (fail closed);
 * pass a subject as well to see only that principal's grants.
 */
export function listCapabilities(subject?: string, limit = 100, org?: string): Capability[] {
  if (!org?.trim()) return [];
  const rows = subject
    ? getDb().prepare("SELECT * FROM capabilities WHERE org = ? AND subject = ? ORDER BY issued_at DESC LIMIT ?").all(org.trim(), subject, limit)
    : (getDb().prepare("SELECT * FROM capabilities WHERE org = ? ORDER BY issued_at DESC LIMIT ?").all(org.trim(), limit) as Record<string, unknown>[]);
  return rows.map(rowToCap);
}

function rowToCap(r: Record<string, unknown>): Capability {
  return {
    id: String(r.id),
    org: String(r.org ?? "default"),
    subject: String(r.subject),
    connector: String(r.connector),
    action: String(r.action),
    resource: (r.resource as string | null) ?? null,
    scope: String(r.scope),
    expires_at: String(r.expires_at),
    used_count: Number(r.used_count),
    max_uses: r.max_uses === null ? null : Number(r.max_uses),
  };
}

export type CapabilityCheck =
  | { ok: true; capability: Capability }
  | { ok: false; reason: string };

// The enforcement point every connector tool call goes through. The model never
// decides authorization: if no unexpired, non-revoked capability matches the
// exact connector + action (+ resource when the grant names one), the call is
// refused before any credential is decrypted.
export function checkCapability(
  subject: string,
  connector: string,
  action: string,
  resource?: string | null,
): CapabilityCheck {
  const db = getDb();
  const now = new Date().toISOString();
  const rows = db
    .prepare(
      "SELECT * FROM capabilities WHERE subject = ? AND connector = ? AND action = ? AND revoked_at IS NULL AND expires_at > ?",
    )
    .all(subject, connector, action, now) as Record<string, unknown>[];
  const matching = rows.map(rowToCap).filter((c) => {
    if (c.resource === null) return true; // grant covers all resources of this action
    return resource !== null && resource !== undefined && c.resource === resource;
  });
  if (!matching.length) {
    return { ok: false, reason: `No capability grants ${connector}:${action}${resource ? ` on ${resource}` : ""} for this subject.` };
  }
  const withUses = matching.find((c) => c.max_uses === null || c.used_count < c.max_uses) ?? matching[0];
  if (withUses.max_uses !== null && withUses.used_count >= withUses.max_uses) {
    return { ok: false, reason: "Capability exhausted (max uses reached)." };
  }
  // Check and increment in one atomic statement: concurrent callers race on the
  // WHERE clause, and only one wins when the grant is down to its last use.
  const claim =
    withUses.max_uses === null
      ? db.prepare("UPDATE capabilities SET used_count = used_count + 1 WHERE id = ?").run(withUses.id)
      : db
          .prepare("UPDATE capabilities SET used_count = used_count + 1 WHERE id = ? AND used_count < max_uses")
          .run(withUses.id);
  if (claim.changes === 0) {
    return { ok: false, reason: "Capability exhausted (max uses reached)." };
  }
  return { ok: true, capability: getCapability(withUses.id) ?? withUses };
}

export function revokeCapability(id: string): boolean {
  return getDb()
    .prepare("UPDATE capabilities SET revoked_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ? AND revoked_at IS NULL")
    .run(id).changes > 0;
}

// Housekeeping: delete expired grants (expiry already denies them; this clears rows).
export function purgeExpired(): number {
  return Number(
    getDb()
      .prepare("DELETE FROM capabilities WHERE expires_at < strftime('%Y-%m-%dT%H:%M:%fZ','now')")
      .run().changes,
  );
}
