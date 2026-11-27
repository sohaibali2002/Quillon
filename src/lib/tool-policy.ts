// Tool policy applied at the route boundary, before tools reach the model:
// per-call timeouts (one hung provider call must not strand the whole stream),
// capability grants for connector actions (the model never authorizes itself),
// and a relevance shortlist so a 300-tool registry does not cost prompt tokens
// and selection accuracy on every turn.
import type { Tool, ToolSet } from "ai";
import { checkCapability } from "@/lib/capability";
import type { ToolCatalogEntry } from "@/lib/tool-registry";

export const TOOL_TIMEOUT_MS = 30_000;

// Always sent: the general-purpose surfaces every turn may need.
const CORE_TOOLS = new Set([
  "runCode",
  "makeDocument",
  "searchConnector",
  "orchestrate",
  "memory_save",
  "memory_read",
  "memory_list",
  "memory_forget",
]);

type ExecutingTool = Tool & { execute?: (input: never, options: never) => unknown };

// One uniform timeout per tool execution, with an error the model can read and
// recover from, instead of the stream hanging on a provider that never answers.
export function withToolTimeouts(tools: ToolSet, timeoutMs = TOOL_TIMEOUT_MS): ToolSet {
  const out: ToolSet = {};
  for (const [name, impl] of Object.entries(tools)) {
    const executing = impl as ExecutingTool;
    if (typeof executing.execute !== "function") {
      out[name] = impl;
      continue;
    }
    const execute = executing.execute.bind(executing);
    out[name] = {
      ...executing,
      execute: async (input: never, options: never) => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          return await Promise.race([
            execute(input, options),
            new Promise((_, reject) => {
              timer = setTimeout(
                () => reject(new Error(`Tool "${name}" timed out after ${timeoutMs / 1000}s.`)),
                timeoutMs,
              );
            }),
          ]);
        } finally {
          if (timer) clearTimeout(timer);
        }
      },
    } as unknown as ToolSet[string];
  }
  return out;
}

// Strict capability enforcement is opt-in: when QUILLON_REQUIRE_GRANTS=1 every
// connector-backed tool call must hold an unexpired grant for
// `connector:action` under the subject (the conversation id by default).
// Without the flag the platform keeps its historical open-loop behaviour.
export function enforceCapabilities(
  tools: ToolSet,
  catalog: ToolCatalogEntry[],
  subject: string,
): ToolSet {
  if (process.env.QUILLON_REQUIRE_GRANTS !== "1") return tools;
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
          subject,
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
