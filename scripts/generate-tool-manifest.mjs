// Regenerates src/lib/tool-manifest.ts from the tool declarations.
//
// The manifest is the authority for tool permissions: classifyTool reads it and
// never infers a class from a tool name. This script keeps the table in step
// with the integrations (OR_TOOLS, SF_TOOLS, HS_TOOLS, NS_TOOLS, CP_TOOLS and
// ENTERPRISE_RECIPES) and folds in the explicit overrides below.
//
//   node --loader ./scripts/ts-resolve.mjs scripts/generate-tool-manifest.mjs
//
// scripts/check-security.mjs fails when a declared tool is missing from the
// manifest, so a new integration cannot ship without a permission class.
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { SF_TOOLS } from "@/lib/salesforce";
import { HS_TOOLS } from "@/lib/hubspot";
import { NS_TOOLS } from "@/lib/netsuite";
import { CP_TOOLS } from "@/lib/costpoint";
import { OR_TOOLS } from "@/lib/openrouter";
import { ENTERPRISE_RECIPES } from "@/lib/enterprise-platforms";

// Classes that the name rules below cannot infer.
const OVERRIDES = {
  // Arbitrary code execution reaches everything the platform can.
  runCode: "admin",
  // Raw passthrough to any OpenRouter endpoint, including the administrative
  // routes the table keeps out of a member session.
  or_request: "admin",
  orchestrate: "write",
  // A chat completion creates no state: it stays a read so viewers can talk to
  // the assistant.
  or_chat: "read",
  // SuiteQL is read-only by contract (the client refuses anything that is not a
  // single SELECT), so it belongs with the reads.
  ns_suiteql: "read",
  remember: "write",
  recall: "read",
  makeDocument: "write",
  searchConnector: "read",
};

const classForMethod = (method) => (method === "GET" ? "read" : method === "DELETE" ? "destructive" : "write");

function byMethod(list, prefix) {
  return list.map((t) => [prefix + t.name, classForMethod((t.endpoint ?? "").split(" ")[0])]);
}

const groups = {
  builtin: Object.entries(OVERRIDES).filter(([name]) =>
    ["runCode", "makeDocument", "searchConnector", "orchestrate", "remember", "recall"].includes(name),
  ),
  openrouter: byMethod(OR_TOOLS, "or_"),
  salesforce: byMethod(SF_TOOLS, "sf_"),
  netsuite: byMethod(NS_TOOLS, "ns_"),
  costpoint: byMethod(CP_TOOLS, "cp_"),
  hubspot: HS_TOOLS.map((t) => [
    "hs_" + t.name,
    /(^|_)(delete|archive|batch|merge)(_|$)/.test(t.name)
      ? "destructive"
      : /(^|_)(create|update|upsert|add|set|write|associate|enroll)(_|$)/.test(t.name)
        ? "write"
        : "read",
  ]),
  enterprise: ENTERPRISE_RECIPES.flatMap((r) =>
    r.actions.map((a) => [`ent_${r.id}_${a.id}`, classForMethod(a.method)]),
  ),
};

// Governance surface: identity, tenancy, billing and credential management stay
// administrator-only even when the underlying call is a plain write.
const GOVERNANCE =
  /(^|_)(workspace|workspaces|organization|org|member|members|budget|credit|credits|guardrail|guardrails|provider|providers|endpoint|endpoints|byok|external_user|external_users|invite|provision|observability|settings|admin|role|permission)(_|$)/i;
const CREDENTIAL = /(^|_)(key|keys|secret|secrets|token|tokens|credential|credentials)(_|$)/i;

for (const list of Object.values(groups)) {
  for (let i = 0; i < list.length; i++) {
    const [name, cls] = list[i];
    if (OVERRIDES[name]) {
      list[i] = [name, OVERRIDES[name]];
    } else if (CREDENTIAL.test(name) || (GOVERNANCE.test(name) && cls !== "read")) {
      list[i] = [name, "admin"];
    }
  }
}

const header = `// Explicit tool permission manifest: the single authority for every built-in,
// connector and ERP tool the platform can hand to a model. classifyTool reads
// this table and never infers a class from a tool's name, so an administrative
// operation cannot slip through as an ordinary write because its name did not
// match a pattern. A tool that is not listed here is denied to every role.
//
// The name lists are generated from the tool declarations (SF_TOOLS, OR_TOOLS,
// ENTERPRISE_RECIPES, ...); scripts/check-security.mjs fails when a declaration
// is missing from this file, and scripts/generate-tool-manifest.mjs regenerates
// the lists after new integrations land.

export type ToolClass = "read" | "write" | "destructive" | "admin";

export const TOOL_CLASSES: Readonly<Record<string, ToolClass>> = {
`;

let out = header;
for (const [group, list] of Object.entries(groups)) {
  out += `  // ${group}\n`;
  for (const [name, cls] of list) out += `  ${JSON.stringify(name)}: "${cls}",\n`;
}
out += "};\n";

const target = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "lib", "tool-manifest.ts");
writeFileSync(target, out);
console.log(`tool-manifest.ts written: ${Object.values(groups).flat().length} tools`);
