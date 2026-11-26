// Route security: authentication, RBAC, CSRF and audit logging for every
// sensitive API route. Enforcement turns on when an identity provider is
// configured or QUILLON_REQUIRE_AUTH=1; local development stays open.
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
// for local development. A production build must opt in explicitly — a server
// that is merely missing its SSO configuration never silently opens up.
export function openModeAllowed(): boolean {
  return process.env.NODE_ENV !== "production" || process.env.QUILLON_OPEN_MODE === "1";
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

// CSRF defense for cookie-authenticated state changes: browsers send Origin on
// unsafe methods, so a mismatching Origin is rejected, and a missing Origin on
// a cookie-authenticated write is rejected too (curl must send it explicitly).
function csrfCheck(req: Request): Response | null {
  if (!["POST", "PUT", "PATCH", "DELETE"].includes(req.method)) return null;
  const origin = req.headers.get("origin");
  const host = req.headers.get("host");
  if (!origin) return hasSessionCookie(req) ? forbidden("Missing Origin header.") : null;
  try {
    if (new URL(origin).host === host) return null;
  } catch {
    // malformed origin -> reject below
  }
  return forbidden("Cross-origin request rejected.");
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
    if (!openModeAllowed()) {
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

// Append-only audit trail: who did what, to what, when, from where.
export function audit(
  req: Request,
  session: Session | null,
  action: string,
  resource: string,
  detail: Record<string, unknown> = {},
) {
  try {
    getDb()
      .prepare(
        "INSERT INTO audit_log (org, actor, action, resource, detail, ip) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(
        session?.sub ?? "anonymous",
        session?.email ?? "anonymous",
        action,
        resource,
        JSON.stringify(detail),
        req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
      );
  } catch {
    // Auditing must never break the request path; DB issues surface elsewhere.
  }
}

export function listAudit(limit = 100) {
  return (
    getDb()
      .prepare("SELECT * FROM audit_log ORDER BY id DESC LIMIT ?")
      .all(limit) as Record<string, unknown>[]
  ).map((r) => ({
    id: Number(r.id),
    actor: String(r.actor),
    action: String(r.action),
    resource: String(r.resource),
    detail: JSON.parse(String(r.detail ?? "{}")) as Record<string, unknown>,
    ip: (r.ip as string | null) ?? null,
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
