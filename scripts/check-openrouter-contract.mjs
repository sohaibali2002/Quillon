// Contract test: every OR_TOOLS entry in src/lib/openrouter.ts must map to a
// tagged operation in openrouter.openapi.yaml (trimmed from the official
// OpenRouter spec), and vice versa. Keeps the contract and the implemented
// tool surface from drifting.
import { readFileSync } from "node:fs";
import { register } from "node:module";

register("./ts-resolve.mjs", import.meta.url);

const { OR_TOOLS } = await import("../src/lib/openrouter.ts");
if (!OR_TOOLS) {
  console.error("FAIL OR_TOOLS registry not found");
  process.exit(1);
}
// or_request is an opt-in escape hatch (OR_ALLOW_RAW=1), not a contract operation.
const CONTRACT_TOOLS = OR_TOOLS.filter((t) => t.name !== "request");

const yaml = readFileSync("openrouter.openapi.yaml", "utf8");
// each operation carries exactly one tag: the OR tool name
const contractOps = [...yaml.matchAll(/^\s*- (\w+)$/gm)].map((m) => m[1]);
const implemented = CONTRACT_TOOLS.map((t) => t.name);

let failures = 0;
for (const name of implemented) {
  const ok = contractOps.includes(name);
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name} ${ok ? "is in the contract" : "MISSING from openrouter.openapi.yaml"}`);
}
for (const op of contractOps) {
  const ok = implemented.includes(op);
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"} contract ${op} ${ok ? "is implemented" : "NOT implemented in OR_TOOLS"}`);
}
console.log(failures ? `FAIL ${failures} contract drift(s)` : "PASS contract and implementation match");
process.exit(failures ? 1 : 0);
