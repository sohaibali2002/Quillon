// Tool authority, enforced outside the model.
//
// A role on the route says who may reach an endpoint; it says nothing about
// which tool an agent may then call. Every tool is classified by what it does,
// and the set handed to the model is filtered by the caller's role so a
// prompt-injected turn cannot reach a credential or delete financial records.
//
//   viewer  read tools only
//   member  read + ordinary writes; destructive and administrative tools denied
//   admin   everything
//
// QUILLON_TOOL_DENY="or_keys_*,cp_delete_*" adds a hard deny list on top, and
// QUILLON_TOOL_ADMIN_ALLOW lets a named tool stay available to members.
import type { ToolSet } from "ai";
import type { Role } from "@/lib/rbac";

export type ToolClass = "read" | "write" | "destructive" | "admin";

const DESTRUCTIVE = /(^|_)(delete|destroy|purge|remove|void|drop|revoke|transform|approve|refund|cancel|post_labor|batch|execute|send)(_|$)/i;
const WRITE = /(^|_)(create|update|patch|upsert|set|write|post|put|add|generate|upload|move|assign|import)(_|$)/i;

// Administrative surfaces: credentials, tenants, budgets, guardrails, org
// settings and private endpoints are not something an agent session should hold
// even when the same API key could technically call them.
const ADMIN = /^(or_(keys?|workspaces?|budget|credits?|organization|org_|guardrails?|endpoints?|providers?|byok|members?|users?|observability|analytics)_)|^(mcp_|skill_(install|remove|write))/i;

export function classifyTool(name: string): ToolClass {
  if (ADMIN.test(name)) return "admin";
  if (DESTRUCTIVE.test(name)) return "destructive";
  if (WRITE.test(name)) return "write";
  return "read";
}

function denyList(): string[] {
  return (process.env.QUILLON_TOOL_DENY ?? "")
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);
}

function adminAllowList(): string[] {
  return (process.env.QUILLON_TOOL_ADMIN_ALLOW ?? "")
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);
}

function matches(patterns: string[], name: string): boolean {
  return patterns.some((p) => (p.endsWith("*") ? name.startsWith(p.slice(0, -1)) : name === p));
}

/** Why the role may not call this tool, or null when it may. */
export function toolAuthorityReason(name: string, role: Role): string | null {
  if (matches(denyList(), name)) return `"${name}" is blocked by QUILLON_TOOL_DENY.`;
  const cls = classifyTool(name);
  if (cls === "read") return null;
  if (role === "admin") return null;
  if (role === "member") {
    if (cls === "write") return null;
    if (matches(adminAllowList(), name)) return null;
    return cls === "destructive"
      ? `"${name}" changes or removes records and needs an administrator.`
      : `"${name}" administers provider or platform credentials and needs an administrator.`;
  }
  return `"${name}" writes data; the viewer role is read-only.`;
}

/** Removes tools the role may not call. */
export function enforceToolAuthority(tools: ToolSet, role: Role): ToolSet {
  const out: ToolSet = {};
  for (const [name, tool] of Object.entries(tools)) {
    if (toolAuthorityReason(name, role) === null) out[name] = tool;
  }
  return out;
}

export function allowedToolNames(tools: ToolSet, role: Role): string[] {
  return Object.keys(tools).filter((name) => toolAuthorityReason(name, role) === null);
}
