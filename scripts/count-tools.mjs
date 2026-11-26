// Counts the native enterprise tools the SDK generates from the recipes.
import { ENTERPRISE_RECIPES } from "../src/lib/enterprise-platforms.ts";

let n = 0;
for (const r of ENTERPRISE_RECIPES) {
  n += r.actions.length;
  console.log(r.id.padEnd(14), String(r.actions.length).padStart(2), "actions");
}
console.log("TOTAL actions ->", n, "native tools");
