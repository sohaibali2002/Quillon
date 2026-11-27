// Contract test: every SF_TOOLS entry in src/lib/salesforce.ts must have a
// matching operationId in salesforce.openapi.yaml, and vice versa. Keeps the
// contract and the implemented tool surface from drifting.
import { readFile } from "node:fs/promises";

const src = await readFile("src/lib/salesforce.ts", "utf8");
const contract = await readFile("salesforce.openapi.yaml", "utf8");

const registry = src.match(/name: "(\w+)"/g).map((m) => m.slice(7, -1));
const registered = (src.match(/^\s{2}t\(\s*$/gm) || []).length;
const contractIds = contract.match(/operationId: sf_\w+/g).map((m) => m.slice(13));

let failures = 0;
const check = (ok, msg) => {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"} ${msg}`);
};

check(registered === registry.length, `t() registration count matches registry (${registry.length})`);
const missingInContract = registry.filter((n) => !contractIds.includes(`sf_${n}`));
check(missingInContract.length === 0, `every SF_TOOLS entry has an operationId${missingInContract.length ? ` — missing: ${missingInContract}` : ""}`);
const notImplemented = contractIds.filter((id) => !registry.includes(id.slice(3)));
check(notImplemented.length === 0, `every contract operation is implemented${notImplemented.length ? ` — extra: ${notImplemented}` : ""}`);
check(/API_VERSION = "v\d+\.\d+"/.test(src), "API version constant is pinned");

process.exit(failures ? 1 : 0);
