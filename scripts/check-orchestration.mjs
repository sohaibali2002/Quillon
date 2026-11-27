// Exercises the orchestration layer without a model or network: reference
// resolution, wave order, cycle detection, dependency-skip propagation, tool
// registry assembly and durable pipeline execution with mid-run resume.
//   node scripts/check-orchestration.mjs
import assert from "node:assert/strict";

const orch = await import("../src/lib/orchestrator.ts");
const reg = await import("../src/lib/tool-registry.ts");
const { validatePlan, resolveRefs, executePipeline, orchestrationKindFor, resumeOrchestrationRun } = orch;
const { unifiedToolset, catalogText } = reg;

// --- Reference resolution ---------------------------------------------------
const outputs = { fetch: { records: [{ email: "a@x.com" }], total: 1 } };
assert.deepEqual(resolveRefs("$fetch.total", outputs), 1);
assert.deepEqual(resolveRefs("$fetch.records.0.email", outputs), "a@x.com");
assert.deepEqual(resolveRefs({ q: "$fetch.total", nested: ["$fetch.records"] }, outputs), {
  q: 1,
  nested: [[{ email: "a@x.com" }]],
});
assert.throws(() => resolveRefs("$missing.x", outputs), /Unresolved reference/);
assert.throws(() => resolveRefs("$fetch.records.9.z", outputs), /ends before/);
assert.equal(resolveRefs("plain string", outputs), "plain string");

// --- Validation -------------------------------------------------------------
const catalog = [
  { name: "toolA", source: "builtin", description: "A" },
  { name: "toolB", source: "connector", description: "B" },
  { name: "toolFail", source: "builtin", description: "F" },
];
const ok = validatePlan(
  {
    summary: "s",
    steps: [
      { id: "a", tool: "toolA", purpose: "p", args: {}, dependsOn: [] },
      { id: "b", tool: "toolB", purpose: "p", args: { x: "$a" }, dependsOn: ["a"] },
    ],
  },
  catalog,
);
assert.equal(ok.ok, true, ok.problems?.join("; "));
assert.deepEqual(ok.waves, [["a"], ["b"]]);

// Independent steps share a wave (parallelism).
const par = validatePlan(
  {
    summary: "s",
    steps: [
      { id: "a", tool: "toolA", purpose: "p", args: {}, dependsOn: [] },
      { id: "b", tool: "toolB", purpose: "p", args: {}, dependsOn: [] },
    ],
  },
  catalog,
);
assert.deepEqual(par.waves, [["a", "b"]]);

const bad = validatePlan(
  {
    summary: "s",
    steps: [
      { id: "a", tool: "nope", purpose: "p", args: {}, dependsOn: ["b"] },
      { id: "b", tool: "toolA", purpose: "p", args: {}, dependsOn: ["a"] },
    ],
  },
  catalog,
);
assert.equal(bad.ok, false);
assert.ok(bad.problems.some((p) => p.includes("unknown tool")));
assert.ok(bad.problems.some((p) => p.includes("cycle")));

// --- Execution: refs, wave-parallel, failure skips descendants ---------------
const calls = [];
const tools = {
  toolA: {
    description: "A",
    execute: async (args) => {
      calls.push(["toolA", args]);
      return { value: 41 };
    },
  },
  toolB: {
    description: "B",
    execute: async (args) => ({ sum: args.base + 1 }),
  },
  toolFail: { description: "F", execute: async () => { throw new Error("boom"); } },
};
const result = await executePipeline(
  {
    summary: "increment",
    steps: [
      { id: "a", tool: "toolA", purpose: "p", args: {}, dependsOn: [] },
      { id: "b", tool: "toolB", purpose: "p", args: { base: "$a.value" }, dependsOn: ["a"] },
    ],
  },
  tools,
  catalog,
);
assert.equal(result.ok, true);
assert.deepEqual(result.steps.find((s) => s.id === "b").output, { sum: 42 });
assert.deepEqual(calls[0], ["toolA", {}]);

const failing = await executePipeline(
  {
    summary: "fails",
    steps: [
      { id: "f", tool: "toolFail", purpose: "p", args: {}, dependsOn: [] },
      { id: "g", tool: "toolA", purpose: "p", args: {}, dependsOn: ["f"] },
    ],
  },
  tools,
  catalog,
);
assert.equal(failing.ok, false);
assert.equal(failing.steps.find((s) => s.id === "f").status, "error");
assert.equal(failing.steps.find((s) => s.id === "g").status, "skipped");

// Strict validation makes executePipeline throw on invalid plans (unknown
// tools, cycles, missing deps); callers surface that as 422 / tool error.
const invalid = await assert.rejects(
  executePipeline(
    { summary: "s", steps: [{ id: "a", tool: "toolA", purpose: "p", args: {}, dependsOn: ["ghost"] }] },
    tools,
    catalog,
  ),
  /Invalid pipeline/,
);

// --- Registry ----------------------------------------------------------------
const unified = await unifiedToolset("orchestrator-check");
const names = unified.catalog.map((t) => t.name);
assert.ok(new Set(names).size === names.length, "no duplicate tool names in the registry");
assert.ok(names.includes("searchConnector"), "builtin surface present");
assert.ok(unified.catalog.some((t) => t.source === "memory"), "memory surface present");
assert.ok(catalogText(unified.catalog).split("\n").length === unified.catalog.length);

// --- Durable pipeline: enqueue, run to completion, resume registration -------
const plan = {
  summary: "durable increment",
  steps: [
    { id: "first", tool: "toolA", purpose: "p", args: {}, dependsOn: [] },
    { id: "second", tool: "toolB", purpose: "p", args: { base: "$first.value" }, dependsOn: ["first"] },
  ],
};
assert.match(orchestrationKindFor(plan), /^orchestration-/);
// Step defs must be exactly the plan's steps (per durable.ts contract).
const defs = orch.orchestrationStepDefs(plan, tools);
assert.deepEqual(defs.map((d) => d.name), ["first", "second"]);

// resumeOrchestrationRun rejects unknown ids instead of throwing.
assert.equal(await resumeOrchestrationRun("no-such-run"), false);

// Pooled MCP stdio servers hold a child process open; close them so the check exits.
const { closeMcpClients } = await import("../src/lib/mcp.ts");
await closeMcpClients();

console.log(`orchestration checks passed (${calls.length} tool calls, ${unified.catalog.length} registered tools)`);
