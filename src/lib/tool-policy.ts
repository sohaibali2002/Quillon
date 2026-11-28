// Tool policy applied at the route boundary, before tools reach the model:
// per-call timeouts that really cancel the work (one hung provider call must not
// strand the stream, and a timed-out write must not keep running behind it),
// capability grants for connector actions (the model never authorizes itself),
// record-level restrictions for ERP/CRM writes, and a relevance shortlist so a
// 300-tool registry does not cost prompt tokens on every turn.
import type { Tool, ToolSet } from "ai";
import { checkCapability } from "@/lib/capability";
import { redactDeep, safeErrorMessage } from "@/lib/sanitize";
import { withToolSignal } from "@/lib/tool-signal";
import { toolVerdict } from "@/lib/tool-authority";
import { recordPolicyReason } from "@/lib/record-policy";
import type { Role } from "@/lib/rbac";
import type { ToolCatalogEntry } from "@/lib/tool-registry";

export const TOOL_TIMEOUT_MS = 30_000;

// Always sent: the general-purpose surfaces every turn may need.
const CORE_TOOLS = new Set([
  "runCode",
  "makeDocument",
  "searchConnector",
  "orchestrate",
  "remember",
  "recall",
  "memory_save",
  "memory_read",
  "memory_list",
  "memory_forget",
]);

type ExecutingTool = Tool & { execute?: (input: never, options: never) => unknown };

// One uniform timeout per tool execution, with an error the model can read and
// recover from, instead of the stream hanging on a provider that never answers.
// The timeout aborts the call's signal (connector fetches honour it), so the
// outbound request stops instead of finishing behind the model's back; a write
// that timed out is still reported as "outcome unknown" so the model re-reads
// the record before retrying.
export function withToolTimeouts(tools: ToolSet, timeoutMs = TOOL_TIMEOUT_MS): ToolSet {
  const out: ToolSet = {};
  for (const [name, impl] of Object.entries(tools)) {
    const executing = impl as ExecutingTool;
    if (typeof executing.execute !== "function") {
      out[name] = impl;
      continue;
    }
    const execute = executing.execute.bind(executing);
    const writes = toolVerdict(name).class !== "read";
    out[name] = {
      ...executing,
      execute: async (input: never, options: never) => {
        const controller = new AbortController();
        let timer: ReturnType<typeof setTimeout> | undefined;
        const timedOut = new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            controller.abort(new Error(`Tool "${name}" timed out.`));
            reject(
              new Error(
                writes
                  ? `Tool "${name}" timed out after ${timeoutMs / 1000}s. The request was cancelled, but the remote system may already have applied it: read the record back before retrying rather than repeating the write.`
                  : `Tool "${name}" timed out after ${timeoutMs / 1000}s and the request was cancelled.`,
              ),
            );
          }, timeoutMs);
        });
        const callOptions = { ...(options as Record<string, unknown> | undefined), abortSignal: controller.signal };
        try {
          const result = await Promise.race([
            withToolSignal(controller.signal, () => execute(input, callOptions as never)),
            timedOut,
          ]);
          // Tool output is attacker-adjacent (third-party API bodies, file
          // contents) and goes straight into the model context: scrub any
          // credential this process holds before it gets there. Base64 runs
          // stay intact so generated-file data URLs still download.
          return redactDeep(result, { keepBase64: true });
        } catch (err) {
          // Provider and DB errors quote URLs, query text and connection
          // strings; the model gets a short, sanitised sentence instead.
          throw new Error(safeErrorMessage(err, `Tool "${name}" failed.`));
        } finally {
          if (timer) clearTimeout(timer);
        }
      },
    } as unknown as ToolSet[string];
  }
  return out;
}

export type CapabilityRequest = {
  /** Authenticated subject: organization and user id, never a conversation id. */
  subject: string;
  role: Role;
};

/**
 * Grants are mandatory for every non-administrator session, and for everyone
 * when QUILLON_REQUIRE_GRANTS=1. An administrator already holds the whole
 * platform, so requiring them to grant themselves a capability only trains
 * people to disable the check; a member never gets a connector action without
 * an explicit, expiring, per-`connector:action` grant.
 */
export function capabilitiesRequired(role: Role): boolean {
  const flag = process.env.QUILLON_REQUIRE_GRANTS;
  if (flag === "0") return false;
  if (flag === "1") return true;
  return role !== "admin";
}

export function enforceCapabilities(
  tools: ToolSet,
  catalog: ToolCatalogEntry[],
  request: CapabilityRequest,
): ToolSet {
  if (!capabilitiesRequired(request.role)) return tools;
  const requirements = new Map(
    catalog.filter((c) => c.connector).map((c) => [c.name, c] as const),
  );
  const out: ToolSet = {};
  for (const [name, impl] of Object.entries(tools)) {
    const requirement = requirements.get(name);
    const executing = impl as ExecutingTool;
    if (!requirement || typeof executing.execute !== "function") {
      out[name] = impl;
      continue;
    }
    const execute = executing.execute.bind(executing);
    out[name] = {
      ...executing,
      execute: async (input: never, options: never) => {
        const check = checkCapability(
          request.subject,
          requirement.connector!,
          requirement.action ?? name,
        );
        if (!check.ok) throw new Error(`Capability denied: ${check.reason}`);
        return execute(input, options);
      },
    } as unknown as ToolSet[string];
  }
  return out;
}

/**
 * Refuses ERP/CRM writes that touch restricted record types or fields for
 * anyone below administrator. Reads pass straight through.
 */
export function withRecordPolicy(
  tools: ToolSet,
  catalog: ToolCatalogEntry[],
  role: Role,
): ToolSet {
  if (role === "admin") return tools;
  const requirements = new Map(catalog.map((c) => [c.name, c] as const));
  const out: ToolSet = {};
  for (const [name, impl] of Object.entries(tools)) {
    const entry = requirements.get(name);
    const executing = impl as ExecutingTool;
    if (!entry?.connector || typeof executing.execute !== "function") {
      out[name] = impl;
      continue;
    }
    if (toolVerdict(name).class === "read") {
      out[name] = impl;
      continue;
    }
    const execute = executing.execute.bind(executing);
    out[name] = {
      ...executing,
      execute: async (input: never, options: never) => {
        const reason = recordPolicyReason(entry.connector, entry.action ?? name, input, role);
        if (reason) throw new Error(`Record policy denied: ${reason}`);
        return execute(input, options);
      },
    } as unknown as ToolSet[string];
  }
  return out;
}

// Static relevance filter: core tools plus catalog entries whose name or
// description matches a meaningful word of the user's request, capped at
// `limit`. No embeddings, no extra model call — deterministic and cheap.
export function selectRelevantTools(
  tools: ToolSet,
  catalog: ToolCatalogEntry[],
  query: string,
  limit = 40,
): ToolSet {
  const names = Object.keys(tools);
  if (names.length <= limit) return tools;
  const words = new Set((query.toLowerCase().match(/[a-z0-9]{3,}/g) ?? []).filter((w) => w.length >= 3));
  const score = (entry: ToolCatalogEntry): number => {
    const hay = `${entry.name} ${entry.description}`.toLowerCase();
    let s = 0;
    for (const w of words) if (hay.includes(w)) s += w.length > 4 ? 2 : 1;
    return s;
  };
  const ranked = catalog
    .filter((c) => c.name in tools)
    .map((c) => ({ c, s: CORE_TOOLS.has(c.name) ? Number.MAX_SAFE_INTEGER : score(c) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s)
    .slice(0, limit);
  if (ranked.length === 0) return tools;
  const out: ToolSet = {};
  for (const { c } of ranked) out[c.name] = tools[c.name];
  return out;
}
