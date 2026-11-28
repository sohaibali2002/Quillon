// Tool authority, enforced outside the model.
//
// A role on the route says who may reach an endpoint; it says nothing about
// which tool an agent may then call. Every tool's class comes from the explicit
// permission manifest in tool-manifest.ts — never from its name — and the set
// handed to the model is filtered by the caller's role so a prompt-injected turn
// cannot reach a credential, an administrative endpoint or financial records.
//
//   viewer  read tools only
//   member  read + ordinary writes; destructive and administrative tools denied
//   admin   everything
//
// A tool that is not in the manifest is denied to every role: new integrations
// must declare their class before the model can call them (set
// QUILLON_TOOL_ALLOW_UNLISTED=1 only for a deliberate, temporary exception).
// QUILLON_TOOL_DENY="or_keys_*,cp_delete_*" adds a hard deny list on top, and
// QUILLON_TOOL_ADMIN_ALLOW lets a named tool stay available to members.
import type { ToolSet } from "ai";
import type { Role } from "@/lib/rbac";
import { TOOL_CLASSES, type ToolClass } from "@/lib/tool-manifest";

export type { ToolClass } from "@/lib/tool-manifest";

/** MCP tools are discovered at runtime and named `mcp_<server>_<tool>`. */
const MCP_PREFIX = "mcp_";

function normalizeServer(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, "_");
}

// A discovered MCP tool runs third-party code with whatever reach the server
// process has, so it is administrator-only unless the operator names that
// server in QUILLON_MCP_MEMBER_SERVERS (comma separated, exact server names).
function mcpToolClass(name: string): ToolClass {
  if (!name.startsWith(MCP_PREFIX)) return "admin";
  const servers = (process.env.QUILLON_MCP_MEMBER_SERVERS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => `mcp_${normalizeServer(s)}_`);
  for (const prefix of servers) {
    if (name.startsWith(prefix)) return "write";
  }
  return "admin";
}

export type ToolVerdict =
  | { class: ToolClass; known: true }
  | { class: "unlisted"; known: false; reason: string };

/**
 * The declared class of a tool, or `unlisted` when the manifest has no entry.
 * Dynamic MCP tools are the one family classified outside the table, and only
 * because their names cannot exist before a server is registered.
 */
export function toolVerdict(name: string): ToolVerdict {
  const declared = TOOL_CLASSES[name];
  if (declared) return { class: declared, known: true };
  if (name.startsWith(MCP_PREFIX)) return { class: mcpToolClass(name), known: true };
  return {
    class: "unlisted",
    known: false,
    reason: `"${name}" is not in the tool permission manifest; declare it in src/lib/tool-manifest.ts before the model may call it.`,
  };
}

/** The declared class, or "admin" for anything the manifest does not cover. */
export function classifyTool(name: string): ToolClass {
  const verdict = toolVerdict(name);
  return verdict.known ? verdict.class : "admin";
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
  const verdict = toolVerdict(name);
  if (!verdict.known) {
    if (process.env.QUILLON_TOOL_ALLOW_UNLISTED !== "1") return verdict.reason;
    if (role !== "admin") return `"${name}" has no declared permission class and needs an administrator.`;
    return null;
  }
  const cls = verdict.class;
  if (cls === "read") return null;
  if (role === "admin") return null;
  if (role === "member") {
    if (cls === "write") return null;
    if (matches(adminAllowList(), name)) return null;
    return cls === "destructive"
      ? `"${name}" changes or removes records and needs an administrator.`
      : `"${name}" administers identities, credentials or platform settings and needs an administrator.`;
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
