// Route security: authentication, RBAC, CSRF and audit logging for every
// sensitive API route. Enforcement turns on when an identity provider is
// configured or QUILLON_REQUIRE_AUTH=1; local development stays open.
import { createHash } from "node:crypto";
import { getDb } from "@/lib/db";
import { readSession, ssoConfig, type Session } from "@/lib/auth";
import { roleOf as baseRoleOf, orgForSession as tenantOrgOf, type Role } from "@/lib/rbac";

export type { Role };
// Env-designated admins rank as admin even without an IdP role claim.
export function roleOf(session: Session): Role {
  return isAdmin(session) ? "admin" : baseRoleOf(session);
}
// Tenant key for per-org data (knowledge graph, audit rows).
export const orgForSession = tenantOrgOf;

export function authEnforced(): boolean {
  if (process.env.QUILLON_REQUIRE_AUTH === "1") return true;
  return ssoConfig() !== null;
}

export function adminEmails(): string[] {
  return (process.env.QUILLON_ADMIN_EMAILS ?? "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
}

export function isAdmin(session: Session | null): boolean {
  if (!session) return false;
  if (session.roles?.includes("admin")) return true;
  return adminEmails().includes(session.email?.toLowerCase());
}

// Open mode (an implicit admin session with no identity provider) exists only
// for local development. A production build must opt in explicitly, and even
// then only a loopback (or explicitly listed) host is served in open mode — a
// public production deploy cannot be opened by one stray variable.
let openModeWarned = false;

function hostnameOf(host: string | null): string {
  if (!host) return "";
  return host.replace(/^\[|\]$/g, "").split(":")[0].toLowerCase();
}

export function openModeAllowed(req?: Request): boolean {
  if (process.env.NODE_ENV !== "production") return true;
  if (process.env.QUILLON_OPEN_MODE !== "1") return false;
  const host = hostnameOf(req?.headers.get("host") ?? null);
  const permitted = ["localhost", "127.0.0.1", "::1"].includes(host) ||
    (process.env.QUILLON_OPEN_MODE_HOSTS ?? "")
      .split(",")
      .map((h) => h.trim().toLowerCase())
      .filter(Boolean)
      .includes(host);
  if (!permitted) return false;
  if (!openModeWarned) {
    openModeWarned = true;
    console.warn(
      "[quillon] OPEN MODE is active in a production build: every request is treated as an administrator. " +
        "Set AUTH_ISSUER or QUILLON_REQUIRE_AUTH=1 for any deployment reachable by other people.",
    );
  }
  return true;
}

function unauthorized() {
  return Response.json(
    { error: { code: "unauthorized", message: "Sign in to use this endpoint." } },
    { status: 401 },
  );
}

function forbidden(message = "You do not have permission to do that.") {
  return Response.json({ error: { code: "forbidden", message } }, { status: 403 });
}

function hasSessionCookie(req: Request): boolean {
  return Boolean(req.headers.get("cookie")?.includes("quillon_session="));
}

// CSRF defense for cookie-authenticated state changes. The browser's Origin is
// compared as a full origin (scheme + host + port) against a canonical origin —
// QUILLON_PUBLIC_ORIGIN when configured, otherwise the request's own URL — so a
// spoofed Host header alone cannot satisfy the check. Sec-Fetch-Site adds a
// second, independent signal for browsers that send it.
const UNSAFE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

function canonicalOrigins(req: Request): string[] {
  const configured = (process.env.QUILLON_PUBLIC_ORIGIN ?? "")
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean)
    .map((o) => {
      try {
        return new URL(o).origin;
      } catch {
        return "";
      }
    })
    .filter(Boolean);
  if (configured.length) return configured;
  try {
    return [new URL(req.url).origin];
  } catch {
    return [];
  }
}

function csrfCheck(req: Request): Response | null {
  if (!UNSAFE_METHODS.has(req.method)) return null;
  const site = req.headers.get("sec-fetch-site");
  if (site && site !== "same-origin" && site !== "none") {
    return forbidden("Cross-site request rejected.");
  }
  const origin = req.headers.get("origin");
  if (!origin) return hasSessionCookie(req) ? forbidden("Missing Origin header.") : null;
  let normalised: string;
  try {
    normalised = new URL(origin).origin;
  } catch {
    return forbidden("Cross-origin request rejected.");
  }
  return canonicalOrigins(req).includes(normalised) ? null : forbidden("Cross-origin request rejected.");
}

/**
 * Gate a route. Returns a session to allow, or a Response to reject.
 *   const gate = await guard(req, { role: "admin" });
 *   if (gate instanceof Response) return gate;
 */
export async function guard(
  req: Request,
  opts: { role?: Role } = {},
): Promise<Session | Response> {
  if (!authEnforced()) {
    if (!openModeAllowed(req)) {
      // Fail closed: a locked production server with no IdP must reject rather
      // than hand out an implicit admin session.
      return unauthorized();
    }
    return OPEN_SESSION;
  }
  const csrf = csrfCheck(req);
  if (csrf) return csrf;
  const session = await readSession();
  if (!session) return unauthorized();
  if (opts.role) {
    const rank: Record<Role, number> = { viewer: 1, member: 2, admin: 3 };
    if (rank[roleOf(session)] < rank[opts.role]) return forbidden();
  }
  return session;
}

const OPEN_SESSION: Session = {
  sub: "open",
  name: "Open mode",
  email: "open@quillon.local",
  roles: ["admin"],
  exp: Math.floor(Date.now() / 1000) + 3600,
};

// Append-only, tamper-evident audit trail: every row stores a SHA-256 over its
// own contents plus the previous row's hash, so editing or deleting a record
// breaks the chain and verifyAuditChain() reports where.
//
// Normal callers use audit(), which never breaks the request path. High-risk
// operations use auditStrict(), which refuses to continue when the record
// cannot be written — an action with no trail must not happen silently.
function clientIp(req: Request): string | null {
  // X-Forwarded-For is only meaningful behind a proxy you control; trusting it
  // unconditionally lets any caller write whatever address it likes into the log.
  if (process.env.QUILLON_TRUST_PROXY !== "1") return null;
  const first = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return first && first.length <= 64 ? first : null;
}

function writeAudit(
  req: Request,
  session: Session | null,
  action: string,
  resource: string,
  detail: Record<string, unknown>,
): void {
  const db = getDb();
  const org = session ? orgForSession(session) : "system";
  const actor = session?.sub ?? "anonymous";
  const ip = clientIp(req);
  const at = new Date().toISOString();
  const detailText = JSON.stringify(detail ?? {});
  const last = db.prepare("SELECT hash FROM audit_log ORDER BY id DESC LIMIT 1").get() as
    | { hash: string | null }
    | undefined;
  const prevHash = last?.hash ?? null;
  const hash = createHash("sha256")
    .update(JSON.stringify([prevHash, org, actor, action, resource, detailText, ip, at]))
    .digest("hex");
  db.prepare(
    "INSERT INTO audit_log (org, actor, action, resource, detail, ip, at, prev_hash, hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(org, actor, action, resource, detailText, ip, at, prevHash, hash);
}

export function audit(
  req: Request,
  session: Session | null,
  action: string,
  resource: string,
  detail: Record<string, unknown> = {},
): void {
  try {
    writeAudit(req, session, action, resource, detail);
  } catch {
    // Auditing must never break the request path; strict callers exist for
    // operations where a missing record is itself a security failure.
  }
}

/** Audit that throws instead of swallowing a write failure. */
export function auditStrict(
  req: Request,
  session: Session | null,
  action: string,
  resource: string,
  detail: Record<string, unknown> = {},
): void {
  writeAudit(req, session, action, resource, detail);
}

export function verifyAuditChain(limit = 500): { ok: boolean; checked: number; brokenAt: number | null } {
  const rows = (
    getDb()
      .prepare(
        "SELECT id, org, actor, action, resource, detail, ip, at, prev_hash, hash FROM audit_log ORDER BY id DESC LIMIT ?",
      )
      .all(limit) as Record<string, unknown>[]
  ).reverse();
  let prevHash: string | null = null;
  let brokenAt: number | null = null;
  for (const r of rows) {
    const expected = createHash("sha256")
      .update(
        JSON.stringify([
          prevHash,
          String(r.org),
          String(r.actor),
          String(r.action),
          String(r.resource),
          String(r.detail),
          (r.ip as string | null) ?? null,
          String(r.at),
        ]),
      )
      .digest("hex");
    if (r.hash && r.hash !== expected) {
      brokenAt = Number(r.id);
      break;
    }
    prevHash = (r.hash as string | null) ?? prevHash;
  }
  return { ok: brokenAt === null, checked: rows.length, brokenAt };
}

export function listAudit(limit = 100) {
  return (
    getDb()
      .prepare("SELECT * FROM audit_log ORDER BY id DESC LIMIT ?")
      .all(limit) as Record<string, unknown>[]
  ).map((r) => ({
    id: Number(r.id),
    org: String(r.org ?? "default"),
    actor: String(r.actor),
    action: String(r.action),
    resource: String(r.resource),
    detail: JSON.parse(String(r.detail ?? "{}")) as Record<string, unknown>,
    ip: (r.ip as string | null) ?? null,
    hash: (r.hash as string | null) ?? null,
    at: String(r.at),
  }));
}

// Fail-closed secret resolution: production refuses the dev fallback unless the
// operator opts out explicitly. Rotation accepts a previous key alongside.
export function requireSecret(name: string, candidates: (string | undefined)[]): string {
  const chosen = candidates.find((v) => v && v.trim());
  if (chosen) return chosen.trim();
  const dev = "quillon-dev-key";
  if (process.env.NODE_ENV === "production" && process.env.QUILLON_ALLOW_DEV_SECRET !== "1") {
    throw new Error(
      `Refusing to start with the development fallback for ${name}. Set the environment variable, or QUILLON_ALLOW_DEV_SECRET=1 to accept the risk explicitly.`,
    );
  }
  return dev;
}
