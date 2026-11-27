// Contract test: every HS_TOOLS entry in src/lib/hubspot.ts must have a
// matching operationId in hubspot.openapi.yaml, and vice versa. Keeps the
// contract and the implemented tool surface from drifting.
import { readFile } from "node:fs/promises";

const src = await readFile("src/lib/hubspot.ts", "utf8");
const contract = await readFile("hubspot.openapi.yaml", "utf8");

const registryMatch = src.match(/export const HS_TOOLS[\s\S]*?\n\];/);
if (!registryMatch) {
  console.error("FAIL HS_TOOLS registry not found");
  process.exit(1);
}
const registered = (src.match(/^\s{2}t\(\s*$/gm) || []).length;
const registry = registryMatch[0].match(/name: "(\w+)"/g).map((m) => m.slice(7, -1));
const contractIds = contract.match(/operationId: hs_\w+/g).map((m) => m.slice(13));

let failures = 0;
const check = (ok, msg) => {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"} ${msg}`);
};

check(registered === registry.length, `t() registration count matches registry (${registry.length})`);
const missingInContract = registry.filter((n) => !contractIds.includes(`hs_${n}`));
check(missingInContract.length === 0, `every HS_TOOLS entry has an operationId${missingInContract.length ? ` — missing: ${missingInContract}` : ""}`);
const notImplemented = contractIds.filter((id) => !registry.includes(id.slice(3)));
check(notImplemented.length === 0, `every contract operation is implemented${notImplemented.length ? ` — extra: ${notImplemented}` : ""}`);

process.exit(failures ? 1 : 0);
