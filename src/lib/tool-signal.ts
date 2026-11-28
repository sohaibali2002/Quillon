// The abort signal of the tool call currently executing.
//
// A tool timeout must stop the work, not just stop waiting for it: an HTTP write
// that keeps running after the model has been told "timed out" is how duplicate
// invoices and half-applied updates happen. withToolTimeouts() installs the
// call's signal here and connector-sdk's fetch reads it, so a timeout or a
// cancelled turn really aborts the outbound request.
import { AsyncLocalStorage } from "node:async_hooks";

const store = new AsyncLocalStorage<AbortSignal>();

export function withToolSignal<T>(signal: AbortSignal, fn: () => Promise<T>): Promise<T> {
  return store.run(signal, fn);
}

export function currentToolSignal(): AbortSignal | undefined {
  return store.getStore();
}

/** The active tool signal combined with a per-request deadline. */
export function toolFetchSignal(deadlineMs: number): AbortSignal {
  const deadline = AbortSignal.timeout(deadlineMs);
  const active = currentToolSignal();
  return active ? AbortSignal.any([active, deadline]) : deadline;
}
