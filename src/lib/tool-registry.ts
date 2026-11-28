// Unified tool registry: every tool surface on the platform — built-ins,
// connector recipe actions for connected platforms, the deep Salesforce,
// HubSpot, NetSuite and Costpoint integrations, memory and MCP servers — assembled in one place, so the
// chat loop, agents and the pipeline orchestrator all plan against the same
// toolset instead of each re-aggregating it.
import type { Tool, ToolSet } from "ai";
import { builtinTools } from "@/lib/tools";
import { ENTERPRISE_RECIPES } from "@/lib/enterprise-platforms";
import { buildConnectedTools } from "@/lib/connector-sdk";
import { buildSalesforceTools } from "@/lib/salesforce";
import { buildHubSpotTools } from "@/lib/hubspot";
import { buildNetSuiteTools } from "@/lib/netsuite";
import { buildCostpointTools } from "@/lib/costpoint";
import { buildOpenRouterTools } from "@/lib/openrouter";
import { createMemoryTools, type MemoryIdentity } from "@/lib/memory";
import { mcpToolset } from "@/lib/mcp";

export type ToolSource =
  | "builtin"
  | "connector"
  | "salesforce"
  | "hubspot"
  | "netsuite"
  | "costpoint"
  | "openrouter"
  | "memory"
  | "mcp";

export interface ToolCatalogEntry {
  name: string;
  source: ToolSource;
  description: string;
  /** Capability gate: connector id + action the call must hold a grant for. */
  connector?: string;
  action?: string;
}

export interface UnifiedToolset {
  tools: ToolSet;
  catalog: ToolCatalogEntry[];
  mcpErrors: { server: string; message: string }[];
}

// The generic salesforce/hubspot recipes are superseded by their dedicated
// deep integrations; listing both would put duplicate tools in every prompt.
const DEEP_RECIPES = new Set(["salesforce", "hubspot", "netsuite", "costpoint"]);

// Connector recipe actions are named `ent_<platform>_<action>`; platform ids
// never contain underscores, so the first underscore splits the pair.
function connectorRequirement(name: string): { connector: string; action: string } | undefined {
  if (!name.startsWith("ent_")) return undefined;
  const rest = name.slice("ent_".length);
  const cut = rest.indexOf("_");
  if (cut <= 0) return undefined;
  return { connector: rest.slice(0, cut), action: rest.slice(cut + 1) };
}

function entry(name: string, impl: Tool, source: ToolSource): ToolCatalogEntry {
  const d = impl.description;
  const base: ToolCatalogEntry = {
    name,
    source,
    description: typeof d === "string" ? d : `Tool ${name}`,
  };
  if (source === "connector") return { ...base, ...connectorRequirement(name) };
  if (source === "salesforce" || source === "hubspot" || source === "netsuite" || source === "costpoint" || source === "openrouter") {
    return { ...base, connector: source, action: name };
  }
  return base;
}

export async function unifiedToolset(
  conversationId: string,
  identity: MemoryIdentity = { tenant: "system", owner: "system" },
): Promise<UnifiedToolset> {
  const mcp = await mcpToolset();
  const groups: [ToolSource, Record<string, Tool>][] = [
    ["builtin", builtinTools],
    // buildConnectedTools only emits tools for platforms with a saved token,
    // so every connector entry here is live.
    ["connector", buildConnectedTools(ENTERPRISE_RECIPES.filter((r) => !DEEP_RECIPES.has(r.id)))],
    ["salesforce", buildSalesforceTools()],
    ["hubspot", buildHubSpotTools()],
    ["netsuite", buildNetSuiteTools()],
    ["costpoint", buildCostpointTools()],
    // OpenRouter registers only when OPENROUTER_API_KEY is set (36 or_* tools).
    ["openrouter", buildOpenRouterTools()],
    ["memory", createMemoryTools(identity, conversationId)],
    ["mcp", mcp.tools],
  ];
  const tools: ToolSet = {};
  const catalog: ToolCatalogEntry[] = [];
  for (const [source, group] of groups) {
    for (const [name, impl] of Object.entries(group)) {
      if (name in tools) continue; // first surface wins, never double-register
      tools[name] = impl;
      catalog.push(entry(name, impl, source));
    }
  }
  return { tools, catalog, mcpErrors: mcp.errors };
}

// Planner prompt form of the catalog: one line per tool.
export function catalogText(catalog: ToolCatalogEntry[]): string {
  return catalog.map((t) => `- ${t.name} [${t.source}]: ${t.description}`).join("\n");
}
