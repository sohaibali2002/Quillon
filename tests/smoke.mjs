// Smoke test: starts the built server in mock mode, exercises every route,
// writes metrics to tests/smoke-results.json. No provider key needed.
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";

const PORT = 3111;
const BASE = `http://127.0.0.1:${PORT}`;
const results = [];
let failures = 0;

function record(name, ok, detail) {
  results.push({ name, ok, detail });
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}: ${detail}`);
}

async function main() {
  // detached: the wrapper npx spawns becomes its own process group, so teardown
  // can signal npx AND the next-server child. Killing only npx orphans the server
  // on PORT, which then blocks later runs and looks like a second local app.
  const server = spawn("npx", ["next", "start", "-p", String(PORT)], {
    env: { ...process.env, AI_MOCK: "1" },
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  server.stderr.on("data", (d) => process.stderr.write(d));

  const stopServer = () => {
    if (server.exitCode !== null || server.signalCode !== null) return;
    try {
      process.kill(-server.pid, "SIGKILL");
    } catch {
      try {
        server.kill("SIGKILL");
      } catch {}
    }
  };
  process.on("exit", stopServer);
  for (const sig of ["SIGINT", "SIGTERM"]) {
    process.on(sig, () => {
      stopServer();
      process.exit(130);
    });
  }

  try {
    // Wait for the server to accept connections (up to 30s).
    let ready = false;
    for (let i = 0; i < 60; i++) {
      try {
        await fetch(`${BASE}/api/config`, { signal: AbortSignal.timeout(1000) });
        ready = true;
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 500));
      }
    }
    if (!ready) throw new Error("server did not become ready in 30s");

    const up = await fetch(`${BASE}/api/config`);
    if (!up.ok) throw new Error(`server not up: ${up.status}`);
    const cfg = await up.json();
    record("GET /api/config", cfg.defaultModel === "openai/gpt-6-astra" && cfg.models.length === 7, `defaultModel=${cfg.defaultModel}, models=${cfg.models.length}`);

    const gen = await fetch(`${BASE}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "hello" }),
    });
    const genBody = await gen.json();
    record("POST /api/generate (mock)", gen.ok && typeof genBody.text === "string" && genBody.usage?.totalTokens > 0, `finishReason=${genBody.finishReason}, totalTokens=${genBody.usage?.totalTokens}`);

    const chat = await fetch(`${BASE}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: [{ id: "1", role: "user", parts: [{ type: "text", text: "hi" }] }] }),
    });
    const chatText = await chat.text();
    record("POST /api/chat (mock stream)", chat.ok && chatText.length > 0, `content-type=${chat.headers.get("content-type")}, ${chatText.length} bytes`);

    const sandbox = await fetch(`${BASE}/api/sandbox`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ language: "javascript", code: 'console.log("hi"); [1,2,3].map(n => n * 2)' }),
    });
    const sandboxBody = await sandbox.json();
    record(
      "POST /api/sandbox javascript",
      sandbox.ok && sandboxBody.stdout.includes("hi") && sandboxBody.exitCode === 0 && sandboxBody.error === null,
      `exit=${sandboxBody.exitCode}, stdout=${JSON.stringify(sandboxBody.stdout.slice(0, 60))}, durationMs=${sandboxBody.durationMs}`,
    );

    const sandboxPy = await fetch(`${BASE}/api/sandbox`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ language: "python", code: 'import statistics\nprint(statistics.mean([2, 4, 9, 1, 8]))' }),
    });
    const pyBody = await sandboxPy.json();
    record(
      "POST /api/sandbox python",
      sandboxPy.ok && pyBody.stdout.trim() === "4.8" && pyBody.exitCode === 0,
      `stdout=${JSON.stringify(pyBody.stdout.trim())}, exit=${pyBody.exitCode}`,
    );

    const sandboxFiles = await fetch(`${BASE}/api/sandbox`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        language: "python",
        code: 'data = open("data.csv").read()\nprint("lines:", len(data.strip().splitlines()))',
        files: [{ name: "data.csv", content: "a,b\n1,2\n3,4\n5,6" }],
      }),
    });
    const filesBody = await sandboxFiles.json();
    record(
      "POST /api/sandbox file ingestion",
      sandboxFiles.ok && filesBody.stdout.trim() === "lines: 4" && filesBody.filesWritten?.includes("data.csv"),
      `stdout=${JSON.stringify(filesBody.stdout.trim())}, files=${JSON.stringify(filesBody.filesWritten)}`,
    );

    const sandboxBad = await fetch(`${BASE}/api/sandbox`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: "" }),
    });
    record("POST /api/sandbox invalid body (400)", sandboxBad.status === 400, `status=${sandboxBad.status}`);

    const sandboxLoop = await fetch(`${BASE}/api/sandbox`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ language: "python", code: "while True: pass", timeoutMs: 500 }),
    });
    const loopBody = await sandboxLoop.json();
    record(
      "POST /api/sandbox timeout guard",
      sandboxLoop.ok && loopBody.error !== null && loopBody.durationMs < 5000,
      `error=${loopBody.error}, durationMs=${loopBody.durationMs}`,
    );

    record(
      "POST /api/sandbox telemetry fields",
      loopBody.timedOut === true &&
        loopBody.timeoutMs === 500 &&
        Array.isArray(loopBody.command) &&
        loopBody.command[0] === "python3" &&
        typeof loopBody.truncated === "boolean" &&
        typeof loopBody.stdoutChars === "number",
      `timedOut=${loopBody.timedOut}, timeoutMs=${loopBody.timeoutMs}, command=${JSON.stringify(loopBody.command)}, truncated=${loopBody.truncated}`,
    );

    const meta = await fetch(`${BASE}/api/sandbox`);
    const metaBody = await meta.json();
    record(
      "GET /api/sandbox languages + limits",
      meta.ok &&
        metaBody.languages?.includes("python") &&
        metaBody.limits?.timeoutMs === 15000 &&
        metaBody.limits?.files === 20,
      `languages=${metaBody.languages?.length}, timeoutMs=${metaBody.limits?.timeoutMs}`,
    );

    const chatTool = await fetch(`${BASE}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: [{ id: "2", role: "user", parts: [{ type: "text", text: "what is the weather in Paris?" }] }] }),
    });
    const chatToolText = await chatTool.text();
    record(
      "POST /api/chat tool loop (mock)",
      chatTool.ok && chatToolText.includes('"type":"tool-input-available","toolCallId":"mock-weather-1","toolName":"weather"') && chatToolText.includes('"type":"tool-output-available","toolCallId":"mock-weather-1"') && chatToolText.includes('"type":"text-delta"'),
      `tool call: ${chatToolText.includes('"toolName":"weather"')}, executed: ${chatToolText.includes("tool-output-available")}, follow-up text: ${chatToolText.includes('"type":"text-delta"')}`,
    );

    const chatBad = await fetch(`${BASE}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ oops: true }),
    });
    const chatBadBody = await chatBad.json();
    record(
      "POST /api/chat invalid body (400)",
      chatBad.status === 400 && chatBadBody?.error?.message?.length > 0,
      `status=${chatBad.status}, message=${chatBadBody?.error?.message}`,
    );

    const structured = await fetch(`${BASE}/api/structured`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "pasta", kind: "object" }),
    });
    const structuredBody = await structured.json();
    record("POST /api/structured (mock)", structured.ok && "output" in structuredBody, `finishReason=${structuredBody.finishReason}`);

    const structuredArray = await fetch(`${BASE}/api/structured`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "pasta steps", kind: "array" }),
    });
    const structuredArrayBody = await structuredArray.json();
    record(
      "POST /api/structured array (mock)",
      structuredArray.ok && Array.isArray(structuredArrayBody.output) && structuredArrayBody.output.length > 0,
      `output=${JSON.stringify(structuredArrayBody.output)}`,
    );

    const agent = await fetch(`${BASE}/api/agent`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "weather in SF" }),
    });
    const agentText = await agent.text();
    record(
      "POST /api/agent stream (mock)",
      agent.ok && agentText.includes('"type":"text-delta"') && agentText.includes('"toolName":"weather"') && agentText.includes('"tool-output-available"'),
      `streamed text: ${agentText.includes('"type":"text-delta"')}, tool call: ${agentText.includes('"toolName":"weather"')}, tool executed: ${agentText.includes('"tool-output-available"')}`,
    );

    const agentStructured = await fetch(`${BASE}/api/agent`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "Summarize the weather in SF", mode: "structured" }),
    });
    const agentStructuredBody = await agentStructured.json();
    record("POST /api/agent structured (mock)", agentStructured.ok && "output" in agentStructuredBody, `output=${JSON.stringify(agentStructuredBody.output)}`);

    const workflow = await fetch(`${BASE}/api/workflow`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "Plan a small trip: check the weather, convert 75F to Celsius." }),
    });
    const workflowText = await workflow.text();
    record(
      "POST /api/workflow orchestrator->workers->synthesizer (mock)",
      workflow.ok &&
        workflowText.includes('"type":"data-plan"') &&
        (workflowText.match(/"type":"data-task"/g) ?? []).length >= 2 &&
        workflowText.includes('"type":"text-delta"') &&
        workflowText.includes('"type":"data-summary"'),
      `plan: ${workflowText.includes('"type":"data-plan"')}, tasks: ${(workflowText.match(/"type":"data-task"/g) ?? []).length}, synth: ${workflowText.includes('"type":"text-delta"')}`,
    );

    // Telemetry the panels render: per-worker arrival/ms/steps and the stage split.
    const taskParts = [...workflowText.matchAll(/^data: (\{"type":"data-task".*)$/gm)].map((m) => {
      try {
        return JSON.parse(m[1]);
      } catch {
        return null;
      }
    });
    const summaryPart = [...workflowText.matchAll(/^data: (\{"type":"data-summary".*)$/gm)]
      .map((m) => {
        try {
          return JSON.parse(m[1]).data;
        } catch {
          return null;
        }
      })
      .filter(Boolean)
      .pop();
    const metas = taskParts.filter(Boolean).map((p) => p.data.meta);
    record(
      "POST /api/workflow worker telemetry",
      metas.length >= 2 &&
        metas.every((m) => typeof m.ms === "number" && typeof m.steps === "number" && Array.isArray(m.tools)) &&
        new Set(metas.map((m) => m.arrival)).size === metas.length &&
        summaryPart?.breakdown?.planMs >= 0 &&
        summaryPart?.breakdown?.synthMs >= 0 &&
        typeof summaryPart?.tokens === "number",
      `metas=${metas.length}, arrivals=${JSON.stringify(metas.map((m) => m.arrival))}, breakdown=${JSON.stringify(summaryPart?.breakdown)}`,
    );

    const workflowBad = await fetch(`${BASE}/api/workflow`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: [] }),
    });
    const workflowBadBody = await workflowBad.json();
    record(
      "POST /api/workflow missing prompt (400)",
      workflowBad.status === 400 && workflowBadBody?.error?.message?.length > 0,
      `status=${workflowBad.status}, message=${workflowBadBody?.error?.message}`,
    );

    const emb = await fetch(`${BASE}/api/embeddings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ input: "hello world" }),
    });
    const embBody = await emb.json();
    record("POST /api/embeddings (mock)", emb.ok && embBody.dimensions === 16, `dimensions=${embBody.dimensions}`);

    const sim = await fetch(`${BASE}/api/embeddings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ compare: ["hello", "hello"] }),
    });
    const simBody = await sim.json();
    record("POST /api/embeddings compare (mock)", sim.ok && simBody.similarity > 0.99, `similarity=${simBody.similarity}`);

    // --- agent memory ---
    const memPost = await fetch(`${BASE}/api/memory`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "smoke: prefers concise answers", scope: "agent", conversationId: "smoke" }),
    });
    const memBody = await memPost.json();
    record(
      "POST /api/memory: fact persisted",
      memPost.status === 201 && memBody.memory?.scope === "agent",
      `status=${memPost.status}, id=${memBody.memory?.id ? "yes" : "no"}`,
    );

    const memGet = await fetch(`${BASE}/api/memory`);
    const memGetBody = await memGet.json();
    record(
      "GET /api/memory: list includes new fact",
      memGetBody.memories.some((m) => m.content === "smoke: prefers concise answers"),
      `count=${memGetBody.memories.length}`,
    );

    const memBad = await fetch(`${BASE}/api/memory`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "" }),
    });
    record("POST /api/memory invalid body (400)", memBad.status === 400, `status=${memBad.status}`);

    const memDel = await fetch(`${BASE}/api/memory?id=${encodeURIComponent(memBody.memory.id)}`, { method: "DELETE" });
    record("DELETE /api/memory", memDel.status === 204, `status=${memDel.status}`);

    // --- skills ---
    const skillsGet = await fetch(`${BASE}/api/skills`);
    const skillsBody = await skillsGet.json();
    record(
      "GET /api/skills: markdown files on disk",
      Array.isArray(skillsBody.skills) && skillsBody.skills.length >= 2,
      `skills=${skillsBody.skills.map((s) => s.id).join(",")}`,
    );

    // --- MCP: demo stdio server, discovery and a real tool call ---
    const mcpAdd = await fetch(`${BASE}/api/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "add", name: "smoke-demo", transport: "stdio", command: "node", args: ["scripts/demo-mcp-server.mjs"] }),
    });
    const mcpAddBody = await mcpAdd.json();
    record(
      "POST /api/mcp add stdio server",
      mcpAdd.status === 201 && mcpAddBody.server?.transport === "stdio",
      `status=${mcpAdd.status}`,
    );

    const mcpCall = await fetch(`${BASE}/api/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "call", serverId: mcpAddBody.server.id, tool: "word_count", args: { text: "one two three. four." } }),
    });
    const mcpCallBody = await mcpCall.json();
    record(
      "POST /api/mcp call word_count on demo server",
      mcpCall.ok && mcpCallBody.result?.content?.[0]?.text?.includes('"words":4') === true,
      `result=${mcpCallBody.result?.content?.[0]?.text ?? mcpCallBody.error?.message}`,
    );

    const mcpDel = await fetch(`${BASE}/api/mcp?id=${encodeURIComponent(mcpAddBody.server.id)}`, { method: "DELETE" });
    record("DELETE /api/mcp", mcpDel.status === 204, `status=${mcpDel.status}`);

    // --- compaction endpoints ---
    const compGet = await fetch(`${BASE}/api/compaction?conversationId=smoke-none`);
    const compBody = await compGet.json();
    record("GET /api/compaction: empty thread has no summary", compGet.ok && compBody.compaction === null, `compaction=${JSON.stringify(compBody.compaction)}`);

    const compPost = await fetch(`${BASE}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ conversationId: "smoke-compaction", model: "openai/gpt-6-astra", messages: [{ id: "m1", role: "user", parts: [{ type: "text", text: "hi" }] }] }),
    });
    record("POST /api/chat with conversationId (compaction path)", compPost.ok, `status=${compPost.status}`);

    const compMissing = await fetch(`${BASE}/api/compaction`);
    record("GET /api/compaction missing param (400)", compMissing.status === 400, `status=${compMissing.status}`);
  } finally {
    stopServer();
  }

  writeFileSync("tests/smoke-results.json", JSON.stringify({ date: new Date().toISOString(), mode: "mock (AI_MOCK=1)", results }, null, 2));
  console.log(`\n${results.length - failures}/${results.length} passed; metrics written to tests/smoke-results.json`);
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
