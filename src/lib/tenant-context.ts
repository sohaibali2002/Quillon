// Per-request tenant context. Tool builders close over the tenant they were
// built for; their execute callbacks run later inside the AI SDK stream, so a
// plain module variable would leak across concurrent requests. AsyncLocalStorage
// carries the tenant through the same async chain instead. Connectors, MCP and
// uploads read the tenant from here; absence falls back to "default" only for
// single-tenant deployments.
import { AsyncLocalStorage } from "node:async_hooks";

const als = new AsyncLocalStorage<string>();

export function runWithTenant<T>(tenant: string, fn: () => T): T {
  return als.run(tenant, fn);
}

export function currentTenant(): string | null {
  return als.getStore() ?? null;
}

/** The tenant for a credential lookup: explicit argument wins, then context, then the default tenant. */
export function tenantScope(explicit?: string | null): string {
  return explicit ?? currentTenant() ?? "default";
}
