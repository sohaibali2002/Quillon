// Contract test: every CP_TOOLS entry in src/lib/costpoint.ts must have a
// matching operationId in costpoint.openapi.yaml, and vice versa. Keeps the
// contract and the implemented tool surface from drifting.
import { readFileSync } from "node:fs";
import { register } from "node:module";

register("./ts-resolve.mjs", import.meta.url);

const { CP_TOOLS } = await import("../src/lib/costpoint.ts");
if (!CP_TOOLS) {
  console.error("FAIL CP_TOOLS registry not found");
  process.exit(1);
}

const yaml = readFileSync("costpoint.openapi.yaml", "utf8");
const contractOps = [...yaml.matchAll(/^\s{6}operationId:\s*(\S+)\s*$/gm)].map((m) => m[1]);
const implemented = CP_TOOLS.map((t) => `cp_${t.name}`);

let failures = 0;
for (const name of implemented) {
  const ok = contractOps.includes(name);
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name} ${ok ? "has an operationId" : "MISSING from costpoint.openapi.yaml"}`);
}
for (const op of contractOps) {
  const ok = implemented.includes(op);
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"} contract ${op} ${ok ? "is implemented" : "NOT implemented in CP_TOOLS"}`);
}
console.log(failures ? `FAIL ${failures} contract drift(s)` : "PASS contract and implementation match");
process.exit(failures ? 1 : 0);
