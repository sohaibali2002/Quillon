// Resolve hook for check scripts run under plain node: allows the repo's
// bundler-style imports (extensionless relative paths and @/ aliases) in .ts
// sources, and stubs Next runtime-only modules (next/headers).
import { readFile } from "node:fs/promises";

const STUBS = {
  "next/headers": "export const cookies = () => new Map(); export const headers = () => new Map();",
};

export async function load(url, context, next) {
  for (const [mod, src] of Object.entries(STUBS)) {
    if (url === new URL(mod, "file:///").href || url.endsWith(`/node_modules/${mod}`)) {
      return { format: "module", source: src, shortCircuit: true };
    }
  }
  return next(url, context);
}

export async function resolve(specifier, context, next) {
  if (STUBS[specifier]) return { url: new URL(specifier, "file:///").href, shortCircuit: true };
  try {
    return await next(specifier, context);
  } catch (err) {
    if (err?.code !== "ERR_MODULE_NOT_FOUND") throw err;
    if (specifier.startsWith("@/")) {
      return next(new URL(`../src/${specifier.slice(2)}.ts`, import.meta.url).href, context);
    }
    if (specifier.startsWith("./") || specifier.startsWith("../")) {
      return next(specifier + ".ts", context);
    }
    throw err;
  }
}
