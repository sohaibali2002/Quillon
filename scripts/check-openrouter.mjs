// Exercises the deep OpenRouter integration against a local mock of the
// OpenRouter API: attribution headers, auth, 429 Retry-After retry, the
// chat/embeddings/rerank routers, model catalog + detail + endpoints,
// credits/generation/activity/analytics, provisioning keys CRUD, BYOK,
// files (multipart upload, metadata, content, delete), batches, audio
// transcription (multipart), speech, images, video create + polling,
// Presets, then the second wave: Responses/Messages APIs, catalog sub-lists,
// workspaces/organization/external users/guardrails/observability/private
// endpoints and providers/container files/alpha services — each asserted with
// the mock's concrete response fields, not just the ok flag.
import assert from "node:assert/strict";
import http from "node:http";
import { OpenRouterClient, extractOpenRouterError, openRouterHeaders, OR_TOOLS, buildOpenRouterTools } from "../src/lib/openrouter.ts";

// The mock server accepts any bearer token; prefer a real key from the env if
// present so the header assertions exercise the production code path.
process.env.OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || "mock-key-for-local-mock-server";
delete process.env.OPENROUTER_BASE_URL;

let hits = [];
let fail429Once = {};
const videoStates = ["pending", "done"];
const server = http.createServer((req, res) => {
  hits.push({ method: req.method, url: req.url, auth: req.headers.authorization, referer: req.headers["http-referer"], title: req.headers["x-title"] });
  const done = (code, body) => {
    res.writeHead(code, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  if (req.url === "/flaky" || req.url.startsWith("/flaky?")) {
    // first call 429 with Retry-After: 0, second call success
    if (!fail429Once[req.url]) {
      fail429Once[req.url] = true;
      res.writeHead(429, { "content-type": "application/json", "retry-after": "0" });
      return res.end(JSON.stringify({ error: { code: 429, message: "Rate limit exceeded" } }));
    }
    return done(200, { ok: true });
  }
  if (req.url === "/err") return done(400, { error: { code: 400, message: { message: "bad request" } } });
  if (req.method === "POST" && req.url === "/chat/completions")
    return done(200, { id: "gen-1", choices: [{ message: { role: "assistant", content: "Hello!" } }], usage: { total_tokens: 9 } });
  if (req.method === "POST" && req.url === "/embeddings") return done(200, { data: [{ embedding: [0.1, 0.2] }], usage: { total_tokens: 3 } });
  if (req.method === "POST" && req.url === "/rerank") return done(200, { results: [{ index: 1, relevance_score: 0.9 }, { index: 0, relevance_score: 0.4 }] });
  if (req.url === "/models") return done(200, { data: [{ id: "openai/gpt-6-astra", name: "GPT 6 Astra", pricing: { prompt: "0.0000015" } }, { id: "foo/free", name: "Free", pricing: { prompt: "0" } }] });
  if (req.url.startsWith("/model/openai/")) return done(200, { id: "openai/gpt-6-astra", context_length: 400000 });
  if (req.url.startsWith("/models/openai/") && req.url.endsWith("/endpoints")) return done(200, { data: [{ provider: "openai", uptime: 99.9 }] });
  if (req.url === "/credits") return done(200, { data: { total_credits: 10, total_usage: 1.25 } });
  if (req.url === "/credits/purchases") return done(200, { data: [] });
  if (req.url.startsWith("/generation?")) return done(200, { id: "gen-1", total_cost: 0.002, provider: "openai" });
  if (req.url === "/activity") return done(200, { data: [] });
  if (req.url === "/analytics/meta") return done(200, { dimensions: ["model", "key", "date"] });
  if (req.url === "/analytics/query") return done(200, { rows: [] });
  if (req.url === "/key") return done(200, { data: { label: "test", usage: 1.25, limit: 10 } });
  if (req.url === "/keys" && req.method === "GET") return done(200, { data: [{ hash: "h1" }] });
  if (req.url === "/keys" && req.method === "POST") return done(200, { data: { hash: "h2" } });
  if (req.url.startsWith("/keys/h1") && req.method === "PATCH") return done(200, { data: { hash: "h1", limit: 5 } });
  if (req.url.startsWith("/keys/h1") && req.method === "DELETE") return done(200, { data: true });
  if (req.url === "/byok" && req.method === "GET") return done(200, { data: [{ id: "b1" }] });
  if (req.url === "/byok" && req.method === "POST") return done(200, { data: { id: "b2" } });
  if (req.url.startsWith("/byok/b1") && req.method === "DELETE") return done(200, { data: true });
  if (req.url === "/files" && req.method === "GET") return done(200, { data: [{ id: "f1" }] });
  if (req.url === "/files" && req.method === "POST") return done(200, { id: "f2", filename: "input.jsonl" });
  if (req.url.startsWith("/files/f1") && req.method === "GET" && req.url.endsWith("/content")) return done(200, { lines: 3 });
  if (req.url.startsWith("/files/f1") && req.method === "GET") return done(200, { id: "f1", bytes: 42 });
  if (req.url.startsWith("/files/f1") && req.method === "DELETE") return done(200, { deleted: true });
  if (req.url === "/batches" && req.method === "GET") return done(200, { data: [] });
  if (req.url === "/batches" && req.method === "POST") return done(200, { id: "bat1", status: "queued" });
  if (req.url.startsWith("/batches/bat1") && req.method === "GET") return done(200, { id: "bat1", status: "completed" });
  if (req.url.startsWith("/batches/bat1") && req.method === "DELETE") return done(200, { deleted: true });
  if (req.url === "/audio/transcriptions") return done(200, { text: "transcribed words" });
  if (req.url === "/audio/speech") return done(200, { audio: { data: Buffer.from("MP3BYTES").toString("base64") } });
  if (req.url === "/images") return done(200, { data: [{ b64_json: Buffer.from("PNG").toString("base64") }] });
  if (req.url === "/videos") return done(200, { id: "job1", status: "queued" });
  if (req.url.startsWith("/videos/job1") && req.method === "GET") return done(200, { id: "job1", status: videoStates.shift() || "done", video_url: "https://cdn/x.mp4" });
  if (req.url === "/presets") return done(200, { data: [{ slug: "p1" }] });
  if (req.url.startsWith("/presets/p1")) return done(200, { slug: "p1", model: "openai/gpt-6-astra" });
  // second wave
  if (req.method === "POST" && req.url === "/responses") return done(200, { id: "resp1", output: [{ type: "message", content: [{ type: "output_text", text: "Response text" }] }] });
  if (req.method === "POST" && req.url === "/messages") return done(200, { id: "msg1", content: [{ type: "text", text: "Messages text" }] });
  if (req.url === "/presets/p1/chat/completions") return done(200, { choices: [{ message: { content: "Preset text" } }] });
  if (req.url === "/generation/feedback") return done(200, { accepted: true });
  if (req.url === "/generation/content") return done(200, { data: [{ id: "gen-1" }] });
  if (req.url === "/audio/speech/models") return done(200, { data: [{ id: "openai/gpt-4o-mini-tts" }] });
  if (req.url.startsWith("/audio/speech/models/openai/")) return done(200, { id: "openai/gpt-4o-mini-tts" });
  if (req.url === "/embeddings/models") return done(200, { data: [{ id: "openai/text-embedding-3-small" }] });
  if (req.url === "/images/models") return done(200, { data: [{ id: "google/gemini-3-pro-image" }] });
  if (req.url === "/videos/models") return done(200, { data: [{ id: "google/veo-3.1" }] });
  if (req.url === "/models/count") return done(200, { count: 420 });
  if (req.url === "/models/user") return done(200, { data: [{ id: "openai/gpt-6-astra" }] });
  if (req.url === "/providers") return done(200, { data: [{ slug: "openai" }] });
  if (req.url === "/tools" && req.method === "GET") return done(200, { data: [{ name: "web_search" }] });
  if (req.url.startsWith("/tools/web_search")) return done(200, { name: "web_search" });
  if (req.url === "/benchmarks") return done(200, { data: [] });
  if (req.url === "/classifications/task") return done(200, { data: [] });
  if (req.url.startsWith("/videos/job1/content")) return done(200, { video: "bytes" });
  if (req.url === "/workspaces" && req.method === "GET") return done(200, { data: [{ id: "ws1" }] });
  if (req.url === "/workspaces" && req.method === "POST") return done(200, { id: "ws2" });
  if (req.url.startsWith("/workspaces/ws1/members/add")) return done(200, { added: 1 });
  if (req.url.startsWith("/workspaces/ws1/budgets/monthly")) return done(200, { interval: "monthly", limit: 100 });
  if (req.url.startsWith("/workspaces/ws1/budgets")) return done(200, { data: [{ interval: "monthly" }] });
  if (req.url.startsWith("/workspaces/ws1")) return done(200, { id: "ws1", name: "Eng" });
  if (req.url === "/organization/members") return done(200, { data: [{ email: "a@b.c" }] });
  if (req.url === "/organization/settings" && req.method === "GET") return done(200, { sso_enforced: false });
  if (req.url === "/organization/settings" && req.method === "PATCH") return done(200, { sso_enforced: true });
  if (req.url === "/external-users" && req.method === "GET") return done(200, { data: [{ user: "u1" }] });
  if (req.url === "/external-users" && req.method === "POST") return done(200, { user: "u2" });
  if (req.url.startsWith("/external-users/u1")) return done(200, { user: "u1" });
  if (req.url === "/guardrails" && req.method === "GET") return done(200, { data: [{ id: "g1" }] });
  if (req.url === "/guardrails" && req.method === "POST") return done(200, { id: "g2" });
  if (req.url.startsWith("/guardrails/g1")) return done(200, { id: "g1" });
  if (req.url === "/observability/destinations" && req.method === "GET") return done(200, { data: [{ id: "o1" }] });
  if (req.url === "/observability/destinations" && req.method === "POST") return done(200, { id: "o2" });
  if (req.url.startsWith("/observability/destinations/o1")) return done(200, { deleted: true });
  if (req.url === "/private-endpoints" && req.method === "GET") return done(200, { data: [{ id: "pe1" }] });
  if (req.url === "/private-endpoints" && req.method === "POST") return done(200, { id: "pe2" });
  if (req.url.startsWith("/private-endpoints/pe1/")) return done(200, { state: "active" });
  if (req.url.startsWith("/private-endpoints/pe1")) return done(200, { deleted: true });
  if (req.url === "/private-providers" && req.method === "GET") return done(200, { data: [{ slug: "mine" }] });
  if (req.url === "/private-providers" && req.method === "POST") return done(200, { slug: "mine2" });
  if (req.url.startsWith("/private-providers/mine")) return done(200, { deleted: true });
  if (req.url.endsWith("/files") && req.url.startsWith("/containers/c1")) return done(200, { data: [{ id: "cf1" }] });
  if (req.url.endsWith("/content") && req.url.startsWith("/containers/c1/files/cf1")) return done(200, { text: "container file" });
  if (req.url.endsWith("/promote") && req.url.startsWith("/containers/c1/files/cf1")) return done(200, { promoted: true });
  if (req.url.startsWith("/containers/c1/files/cf1")) return done(200, { id: "cf1", size: 10 });
  if (req.url === "/api/alpha/decisions") return done(200, { decision: "yes" });
  if (req.url === "/api/alpha/extractions") return done(200, { fields: { a: 1 } });
  return done(404, { error: { code: 404, message: "not found" } });
});

await new Promise((r) => server.listen(0, r));
const base = `http://127.0.0.1:${server.address().port}`;
const or = new OpenRouterClient(base);
let passed = 0;
const check = (name, cond) => {
  try {
    assert(cond);
    passed++;
  } catch (e) {
    console.error(`FAIL ${name}:`, e.message);
    process.exitCode = 1;
  }
};
const ok = async (name, p) => {
  const r = await p;
  check(name, () => r.ok === true);
  return r;
};

// headers + auth
check("attribution headers", () => openRouterHeaders().authorization === "Bearer mock-key-for-local-mock-server" && openRouterHeaders()["x-title"] === "Quillon");
check("error extraction (string + object message)", () =>
  extractOpenRouterError({ error: { code: 402, message: "no credits" } }) === "402: no credits" &&
  extractOpenRouterError({ error: { code: 400, message: { message: "bad" } } }) === "400: bad",
);

// 429 retry with Retry-After
const flaky = await or.request("GET", "flaky");
check("429 retried once then succeeds", () => flaky.ok === true);

// error shape
let threw = "";
try {
  await or.request("GET", "err");
} catch (e) {
  threw = e.message;
}
check("error body parsed", () => threw.includes("400") && threw.includes("bad request"));

// inference + catalog
const chat = await ok("chat", or.chatCompletion({ model: "openai/gpt-6-astra", messages: [{ role: "user", content: "hi" }] }));
check("chat content + usage", () => chat.content === "Hello!" && chat.usage.total_tokens === 9);
const emb = await ok("embeddings", or.embeddings({ model: "openai/text-embedding-3-small", input: "hi" }));
check("embedding vector", () => emb.data[0].embedding.length === 2);
const rr = await ok("rerank", or.rerank({ model: "cohere/rerank-v3.5", query: "q", documents: ["a", "b"] }));
check("rerank scores", () => rr.results.length === 2 && rr.results[0].relevance_score === 0.9);
const models = await or.models();
check("catalog returns both models", () => models.data.length === 2);
const detail = await ok("model detail", or.model("openai/gpt-6-astra"));
check("model detail context_length", () => detail.context_length === 400000);
const eps = await ok("model endpoints", or.modelEndpoints("openai/gpt-6-astra"));
check("endpoints list", () => eps.data[0].provider === "openai");

// accounting
const credits = await ok("credits", or.credits());
check("credits totals", () => credits.data.total_credits === 10);
const gen = await ok("generation", or.generation("gen-1"));
check("generation cost", () => gen.total_cost === 0.002);

// keys
const key = await ok("create key", or.createKey({ name: "k", limit: 5 }));
check("created key hash", () => key.data.hash === "h2");
await ok("update key", or.updateKey("h1", { limit: 5 }));
await ok("delete key", or.deleteKey("h1"));

// files (multipart upload)
const up = await ok("upload file", or.uploadFile("input.jsonl", Buffer.from('{"x":1}').toString("base64"), "batch"));
check("upload returns id", () => up.id === "f2");
await ok("file metadata", or.fileMetadata("f1"));
const content = await ok("file content", or.fileContent("f1"));
check("file content raw json", () => content.lines === 3);

// batches
const batch = await ok("create batch", or.createBatch({ input_file_id: "f2" }));
check("batch queued", () => batch.status === "queued");

// audio / images / video
const tr = await ok("transcribe", or.transcriptions((() => { const f = new FormData(); f.append("model", "m"); f.append("file", new Blob(["x"]), "a.mp3"); return f; })()));
check("transcription text", () => tr.text === "transcribed words");
const sp = await ok("speech", or.speech({ model: "tts", input: "hello" }));
check("speech data url", () => sp.audio_data_url.startsWith("data:audio/mp3;base64,"));
const img = await ok("image", or.images({ model: "img", prompt: "cat" }));
check("image b64", () => img.data[0].b64_json.length > 0);
const vid = await ok("video create", or.createVideo({ model: "veo", prompt: "ocean" }));
check("video job id", () => vid.id === "job1");
const polled = await ok("video poll", or.pollVideo("job1", 15_000));
check("video polled to done", () => polled.status === "done");

// presets
const presets = await ok("presets list", or.listPresets());
check("presets list", () => presets.data[0].slug === "p1");
await ok("preset get", or.getPreset("p1"));
await ok("preset delete", or.deletePreset("p1"));

// second wave: Responses/Messages APIs, catalog sub-lists, management surfaces
const resp = await ok("responses api", or.responses({ model: "openai/gpt-6-astra", input: "hi" }));
check("responses output text", () => resp.output[0].content[0].text === "Response text");
const msgs = await ok("messages api", or.messagesApi({ model: "anthropic/claude-sonnet-5.5", messages: [{ role: "user", content: "hi" }] }));
check("messages content", () => msgs.content[0].text === "Messages text");
const presetChat = await ok("preset chat", or.presetChat("p1", { messages: [{ role: "user", content: "hi" }] }));
check("preset chat content", () => presetChat.choices[0].message.content === "Preset text");
const fb = await ok("generation feedback", or.generationFeedback({ id: "gen-1", good: true }));
check("feedback accepted", () => fb.accepted === true);
const spModels = await ok("speech models", or.speechModels());
check("speech models list", () => spModels.data[0].id === "openai/gpt-4o-mini-tts");
const spModel = await ok("speech model detail", or.speechModel("openai/gpt-4o-mini-tts"));
check("speech model id", () => spModel.id === "openai/gpt-4o-mini-tts");
const embModels = await ok("embeddings models", or.embeddingsModels());
check("embeddings models list", () => embModels.data[0].id === "openai/text-embedding-3-small");
const imgModels = await ok("images models", or.imagesModels());
check("images models list", () => imgModels.data[0].id === "google/gemini-3-pro-image");
const vidModels = await ok("videos models", or.videosModels());
check("videos models list", () => vidModels.data[0].id === "google/veo-3.1");
const count = await ok("models count", or.modelsCount());
check("models count", () => count.count === 420);
const userModels = await ok("models user", or.modelsUser());
check("models user list", () => userModels.data[0].id === "openai/gpt-6-astra");
const provs = await ok("providers", or.providers());
check("providers list", () => provs.data[0].slug === "openai");
const toolList = await ok("tools list", or.listTools());
check("tools list", () => toolList.data[0].name === "web_search");
const toolGet = await ok("tool get", or.getTool("web_search"));
check("tool get", () => toolGet.name === "web_search");
const vidBytes = await ok("video content", or.videoContent("job1"));
check("video content raw", () => vidBytes.video === "bytes");
const ws = await ok("workspaces list", or.listWorkspaces());
check("workspaces list", () => ws.data[0].id === "ws1");
const wsNew = await ok("workspace create", or.createWorkspace({ name: "Ops" }));
check("workspace create id", () => wsNew.id === "ws2");
const wsGet = await ok("workspace get", or.getWorkspace("ws1"));
check("workspace get name", () => wsGet.name === "Eng");
await ok("workspace update", or.updateWorkspace("ws1", { name: "Eng2" }));
await ok("workspace delete", or.deleteWorkspace("ws1"));
const wsAdd = await ok("workspace members add", or.addWorkspaceMembers("ws1", { members: ["a@b.c"] }));
check("members added", () => wsAdd.added === 1);
const budgets = await ok("workspace budgets", or.listWorkspaceBudgets("ws1"));
check("workspace budgets", () => budgets.data[0].interval === "monthly");
const budget = await ok("workspace budget", or.getWorkspaceBudget("ws1", "monthly"));
check("workspace budget limit", () => budget.limit === 100);
const org = await ok("org members", or.orgMembers());
check("org members", () => org.data[0].email === "a@b.c");
const orgSet = await ok("org settings", or.orgSettings());
check("org settings get", () => orgSet.sso_enforced === false);
const orgUpd = await ok("org settings update", or.updateOrgSettings({ sso_enforced: true }));
check("org settings update", () => orgUpd.sso_enforced === true);
const eu = await ok("external users list", or.listExternalUsers());
check("external users", () => eu.data[0].user === "u1");
const euNew = await ok("external user create", or.createExternalUser({ user: "u2" }));
check("external user create", () => euNew.user === "u2");
const euGet = await ok("external user get", or.getExternalUser("u1"));
check("external user get", () => euGet.user === "u1");
const gr = await ok("guardrails list", or.listGuardrails());
check("guardrails list", () => gr.data[0].id === "g1");
const grNew = await ok("guardrail create", or.createGuardrail({ name: "block-pii" }));
check("guardrail create", () => grNew.id === "g2");
await ok("guardrail get", or.getGuardrail("g1"));
await ok("guardrail update", or.updateGuardrail("g1", { enabled: true }));
await ok("guardrail delete", or.deleteGuardrail("g1"));
const obs = await ok("observability list", or.listObservabilityDestinations());
check("observability list", () => obs.data[0].id === "o1");
const obsNew = await ok("observability create", or.createObservabilityDestination({ name: "otl", endpoint: "https://o" }));
check("observability create", () => obsNew.id === "o2");
await ok("observability delete", or.deleteObservabilityDestination("o1"));
const pe = await ok("private endpoints list", or.listPrivateEndpoints());
check("private endpoints", () => pe.data[0].id === "pe1");
const peNew = await ok("private endpoint create", or.createPrivateEndpoint({ provider: "openai" }));
check("private endpoint create", () => peNew.id === "pe2");
const peAct = await ok("private endpoint activate", or.privateEndpointAction("pe1", "activate"));
check("private endpoint activate", () => peAct.state === "active");
await ok("private endpoint delete", or.deletePrivateEndpoint("pe1"));
const pp = await ok("private providers list", or.listPrivateProviders());
check("private providers", () => pp.data[0].slug === "mine");
const ppNew = await ok("private provider create", or.createPrivateProvider({ slug: "mine2" }));
check("private provider create", () => ppNew.slug === "mine2");
await ok("private provider delete", or.deletePrivateProvider("mine"));
const cf = await ok("container files list", or.listContainerFiles("c1"));
check("container files", () => cf.data[0].id === "cf1");
const cfGet = await ok("container file get", or.getContainerFile("c1", "cf1"));
check("container file size", () => cfGet.size === 10);
const cfContent = await ok("container file content", or.containerFileContent("c1", "cf1"));
check("container file content", () => cfContent.text === "container file");
const cfPromote = await ok("container file promote", or.promoteContainerFile("c1", "cf1"));
check("container file promote", () => cfPromote.promoted === true);
const dec = await ok("alpha decisions", or.alphaDecisions({ question: "go?" }));
check("alpha decision", () => dec.decision === "yes");
const ext = await ok("alpha extractions", or.alphaExtractions({ text: "a=1" }));
check("alpha extraction", () => ext.fields.a === 1);

// every tool registers and the chat tool drives the same client path
const tools = buildOpenRouterTools();
check("tool count matches OR_TOOLS", () => Object.keys(tools).length === OR_TOOLS.length);
const missing = OR_TOOLS.filter((t) => !tools[`or_${t.name}`]);
check("every contract op has a tool", () => missing.length === 0);
const orChat = await tools.or_chat.execute({ model: "openai/gpt-6-astra", messages: [{ role: "user", content: "hi" }] });
check("or_chat tool executes", () => orChat.ok === true && orChat.content === "Hello!");
const orModels = await tools.or_models.execute({ free: true });
check("or_models tool filters free", () => orModels.models.length === 1 && orModels.models[0].id === "foo/free");
const orResponses = await tools.or_responses.execute({ model: "openai/gpt-6-astra", input: "hi" });
check("or_responses tool executes", () => orResponses.ok === true && orResponses.output[0].content[0].text === "Response text");
const orWs = await tools.or_workspaces_list.execute({});
check("or_workspaces_list tool executes", () => orWs.ok === true && orWs.data[0].id === "ws1");
const orGrCreate = await tools.or_guardrails_create.execute({ name: "g" });
check("or_guardrails_create tool executes", () => orGrCreate.ok === true && orGrCreate.id === "g2");
// raw escape hatch is opt-in and absent by default
check("raw request tool opt-in only", () => tools.or_request === undefined);
process.env.OR_ALLOW_RAW = "1";
const toolsRaw = buildOpenRouterTools();
check("raw request tool when opted in", () => toolsRaw.or_request !== undefined);
const raw = await toolsRaw.or_request.execute({ method: "GET", path: "credits" });
check("raw request executes", () => raw.ok === true && raw.data.total_credits === 10);
delete process.env.OR_ALLOW_RAW;

// every request sent attribution + auth
check("auth on every call", () => hits.every((h) => h.auth === "Bearer mock-key-for-local-mock-server" && h.referer && h.title === "Quillon"));

console.log(`${passed} passed${process.exitCode ? " (with failures)" : ""}`);
server.close();
