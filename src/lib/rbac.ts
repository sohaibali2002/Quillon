// Pure RBAC and tenancy helpers — no Next.js imports, so engine unit tests can
// load this module directly under plain Node.
export type Role = "admin" | "member" | "viewer";

export function isAdmin(session: { roles?: string[]; email?: string } | null): boolean {
  if (!session) return false;
  return session.roles?.includes("admin") ?? false;
}

export function roleOf(session: { roles?: string[] }): Role {
  const roles = session.roles ?? [];
  if (roles.includes("admin")) return "admin";
  if (roles.includes("viewer")) return "viewer";
  // A session with no role claim at all is a signed-in user (member). Any
  // unrecognised role is not evidence of write access, so it fails closed to
  // viewer rather than silently granting member.
  if (roles.length === 0) return "member";
  return "viewer";
}

// Tenant key for per-org data (knowledge graph, audit rows). Authenticated
// users are scoped to their email's domain — the enterprise tenancy boundary —
// and open mode (local dev only) shares the single "default" org.
export function orgForSession(session: { sub: string; email?: string }): string {
  if (session.sub === "open") return "default";
  const domain = session.email?.split("@")[1]?.toLowerCase().trim();
  return domain || `user:${session.sub}`;
}

/**
 * The (tenant, owner) pair every personal record is scoped to: the tenant from
 * the session's organisation, the owner from the authenticated subject. An
 * email is only a fallback when the provider sends no subject; the subject is
 * the immutable identifier, an email address is not.
 */
export function principalForSession(session: {
  sub: string;
  email?: string;
}): { tenant: string; owner: string } {
  const owner = (session.sub ?? "").trim() || (session.email ?? "").trim() || "anonymous";
  return { tenant: orgForSession(session), owner };
}
