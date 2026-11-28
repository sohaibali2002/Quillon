// Deep native OpenRouter integration, built against the official OpenRouter
// OpenAPI spec (openrouter.ai/api/v1). Goes beyond the model gateway: the
// full catalog API, chat completions with model fallbacks and provider
// routing, the embeddings and rerank routers, per-generation cost lookups,
// credits and spend analytics, provisioning-key management, BYOK keys, the
// file/batch APIs for bulk work, audio transcription and speech, image
// generation, video generation with polling, and prompt presets.
//
// Auth: a single API key from OPENROUTER_API_KEY, sent as a Bearer token.
// App attribution headers (HTTP-Referer, X-Title) are sent on every call.
// 429/502/503 mean the request was not processed and are retried once with
// Retry-After; ambiguous inference failures are never retried (double spend).
import { tool, type Tool } from "ai";
import { z } from "zod";
import { safeErrorMessage } from "@/lib/sanitize";

export const OPENROUTER_BASE_URL =
  process.env.OPENROUTER_BASE_URL?.replace(/\/+$/, "") || "https://openrouter.ai/api/v1";

export const OPENROUTER_APP_NAME = process.env.OPENROUTER_APP_NAME || "Quillon";
export const OPENROUTER_APP_URL = process.env.APP_URL || "https://github.com/sohaibali2002/Quillon";

export function isOpenRouterConfigured(): boolean {
  return Boolean(process.env.OPENROUTER_API_KEY);
}

/** Attribution + auth headers sent on every OpenRouter call. */
export function openRouterHeaders(): Record<string, string> {
  return {
    authorization: `Bearer ${process.env.OPENROUTER_API_KEY ?? ""}`,
    "http-referer": OPENROUTER_APP_URL,
    "x-title": OPENROUTER_APP_NAME,
  };
}

/** OpenRouter error bodies: {error:{code,message}} (message sometimes an object). */
export function extractOpenRouterError(data: unknown): string | null {
  const err = (data as { error?: { code?: unknown; message?: unknown } } | null)?.error;
  if (!err) return null;
  const message =
    typeof err.message === "string"
      ? err.message
      : err.message && typeof err.message === "object"
        ? String((err.message as { message?: unknown }).message ?? (err.message as { value?: unknown }).value ?? "")
        : "";
  return [err.code, message].filter(Boolean).join(": ") || "OpenRouter error";
}

type OrInit = {
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined>;
  headers?: Record<string, string>;
  /** inference calls get a longer timeout */
  inference?: boolean;
  /** download file content raw */
  raw?: boolean;
  retry?: number;
};

export class OpenRouterClient {
  private base: string;

  constructor(base: string = OPENROUTER_BASE_URL) {
    this.base = base.replace(/\/+$/, "");
  }

  async request<T = unknown>(method: string, path: string, init: OrInit = {}): Promise<T> {
    const url = new URL(`${this.base}/${path.replace(/^\/+/, "")}`);
    for (const [k, v] of Object.entries(init.query ?? {})) {
      if (v !== undefined && v !== "") url.searchParams.set(k, String(v));
    }
    const isForm = init.body instanceof FormData;
    const res = await fetch(url, {
      method,
      headers: {
        ...openRouterHeaders(),
        ...(init.body !== undefined && !isForm ? { "content-type": "application/json" } : {}),
        ...init.headers,
      },
      body: init.body === undefined ? undefined : isForm ? (init.body as FormData) : JSON.stringify(init.body),
      signal: AbortSignal.timeout(init.inference ? 300_000 : 60_000),
    });

    // 429/502/503 mean the request was not processed; retry once honoring
    // Retry-After. Ambiguous inference failures are not retried (double spend).
    const retryable = res.status === 429 || res.status === 502 || res.status === 503;
    if (retryable && (init.retry ?? 0) < 1) {
      const after = Number(res.headers.get("retry-after") ?? "1");
      await new Promise((r) => setTimeout(r, Math.min(5000, Number.isFinite(after) && after > 0 ? after * 1000 : 1000)));
      return this.request<T>(method, path, { ...init, retry: 1 });
    }

    if (init.raw) {
      if (!res.ok) throw new Error(`OpenRouter ${method} ${path} failed: ${res.status}`);
      return (await res.text()) as unknown as T;
    }
    const raw = await res.text();
    let data: unknown = null;
    if (raw) {
      try {
        data = JSON.parse(raw);
      } catch {
        data = raw;
      }
    }
    if (!res.ok) {
      throw new Error(
        `OpenRouter ${method} ${path} failed (${res.status}): ${extractOpenRouterError(data) ?? raw.slice(0, 300)}`,
      );
    }
    return data as T;
  }

  // ---------- inference ----------
  chatCompletion(body: Record<string, unknown>) {
    return this.request<Record<string, unknown>>("POST", "chat/completions", { body, inference: true });
  }
  embeddings(body: Record<string, unknown>) {
    return this.request<Record<string, unknown>>("POST", "embeddings", { body, inference: true });
  }
  rerank(body: Record<string, unknown>) {
    return this.request<Record<string, unknown>>("POST", "rerank", { body, inference: true });
  }
  transcriptions(form: FormData) {
    return this.request<Record<string, unknown>>("POST", "audio/transcriptions", {
      body: form,
      inference: true,
    });
  }
  speech(body: Record<string, unknown>) {
    return this.request<Record<string, unknown>>("POST", "audio/speech", { body, inference: true });
  }
  images(body: Record<string, unknown>) {
    return this.request<Record<string, unknown>>("POST", "images", { body, inference: true });
  }
  createVideo(body: Record<string, unknown>) {
    return this.request<Record<string, unknown>>("POST", "videos", { body, inference: true });
  }
  videoStatus(jobId: string) {
    return this.request<Record<string, unknown>>("GET", `videos/${encodeURIComponent(jobId)}`);
  }
  /** Poll a video job until it leaves the pending states or the deadline passes. */
  async pollVideo(jobId: string, maxWaitMs = 120_000) {
    const deadline = Date.now() + maxWaitMs;
    let last: Record<string, unknown> = {};
    while (Date.now() < deadline) {
      last = await this.videoStatus(jobId);
      const status = String(last.status ?? "");
      if (!["pending", "queued", "in_progress", ""].includes(status)) break;
      await new Promise((r) => setTimeout(r, 5000));
    }
    return last;
  }

  // ---------- catalog ----------
  models() {
    return this.request<{ data: unknown[] }>("GET", "models");
  }
  /** Model detail: id is the full slug "author/slug". */
  model(id: string) {
    const [author, slug] = id.split("/");
    if (!author || !slug) throw new Error(`OpenRouter model id must be "author/slug", got "${id}"`);
    return this.request<Record<string, unknown>>("GET", `model/${encodeURIComponent(author)}/${encodeURIComponent(slug)}`);
  }
  modelEndpoints(id: string) {
    const [author, slug] = id.split("/");
    if (!author || !slug) throw new Error(`OpenRouter model id must be "author/slug", got "${id}"`);
    return this.request<Record<string, unknown>>(
      "GET",
      `models/${encodeURIComponent(author)}/${encodeURIComponent(slug)}/endpoints`,
    );
  }

  // ---------- accounting ----------
  credits() {
    return this.request<Record<string, unknown>>("GET", "credits");
  }
  creditPurchases(query: Record<string, string | number | undefined> = {}) {
    return this.request<Record<string, unknown>>("GET", "credits/purchases", { query });
  }
  generation(id: string) {
    return this.request<Record<string, unknown>>("GET", "generation", { query: { id } });
  }
  activity(query: Record<string, string | number | boolean | undefined> = {}) {
    return this.request<Record<string, unknown>>("GET", "activity", { query });
  }
  analyticsMeta() {
    return this.request<Record<string, unknown>>("GET", "analytics/meta");
  }
  analyticsQuery(body: Record<string, unknown>) {
    return this.request<Record<string, unknown>>("POST", "analytics/query", { body });
  }

  // ---------- key management (requires a management key) ----------
  currentKey() {
    return this.request<Record<string, unknown>>("GET", "key");
  }
  listKeys(query: Record<string, string | number | boolean | undefined> = {}) {
    return this.request<{ data: unknown[] }>("GET", "keys", { query });
  }
  createKey(body: Record<string, unknown>) {
    return this.request<Record<string, unknown>>("POST", "keys", { body });
  }
  getKey(hash: string) {
    return this.request<Record<string, unknown>>("GET", `keys/${encodeURIComponent(hash)}`);
  }
  updateKey(hash: string, body: Record<string, unknown>) {
    return this.request<Record<string, unknown>>("PATCH", `keys/${encodeURIComponent(hash)}`, { body });
  }
  deleteKey(hash: string) {
    return this.request<Record<string, unknown>>("DELETE", `keys/${encodeURIComponent(hash)}`);
  }
  listByok() {
    return this.request<{ data: unknown[] }>("GET", "byok");
  }
  addByok(body: Record<string, unknown>) {
    return this.request<Record<string, unknown>>("POST", "byok", { body });
  }
  deleteByok(id: string) {
    return this.request<Record<string, unknown>>("DELETE", `byok/${encodeURIComponent(id)}`);
  }

  // ---------- files & batches ----------
  listFiles(query: Record<string, string | number | undefined> = {}) {
    return this.request<{ data: unknown[] }>("GET", "files", { query });
  }
  async uploadFile(name: string, contentBase64: string, purpose: string) {
    const bytes = Buffer.from(contentBase64, "base64");
    const form = new FormData();
    form.append("purpose", purpose);
    form.append("file", new Blob([bytes]), name);
    return this.request<Record<string, unknown>>("POST", "files", { body: form });
  }
  fileMetadata(id: string) {
    return this.request<Record<string, unknown>>("GET", `files/${encodeURIComponent(id)}`);
  }
  fileContent(id: string) {
    return this.request<string>("GET", `files/${encodeURIComponent(id)}/content`, { raw: true });
  }
  deleteFile(id: string) {
    return this.request<Record<string, unknown>>("DELETE", `files/${encodeURIComponent(id)}`);
  }
  listBatches(query: Record<string, string | number | undefined> = {}) {
    return this.request<Record<string, unknown>>("GET", "batches", { query });
  }
  createBatch(body: Record<string, unknown>) {
    return this.request<Record<string, unknown>>("POST", "batches", { body });
  }
  getBatch(id: string) {
    return this.request<Record<string, unknown>>("GET", `batches/${encodeURIComponent(id)}`);
  }
  deleteBatch(id: string) {
    return this.request<Record<string, unknown>>("DELETE", `batches/${encodeURIComponent(id)}`);
  }

  // ---------- presets ----------
  listPresets(query: Record<string, string | number | undefined> = {}) {
    return this.request<Record<string, unknown>>("GET", "presets", { query });
  }
  getPreset(uid: string) {
    return this.request<Record<string, unknown>>("GET", `presets/${encodeURIComponent(uid)}`);
  }
  deletePreset(uid: string) {
    return this.request<Record<string, unknown>>("DELETE", `presets/${encodeURIComponent(uid)}`);
  }

  // ---------- second wave: Responses/Messages APIs, catalog sub-lists, enterprise management ----------
  // Inference (Responses + Anthropic-style Messages + preset run)
  responses(body: Record<string, unknown>) {
    return this.request<Record<string, unknown>>("POST", "responses", { body, inference: true });
  }
  messagesApi(body: Record<string, unknown>) {
    return this.request<Record<string, unknown>>("POST", "messages", { body, inference: true });
  }
  presetChat(slug: string, body: Record<string, unknown>) {
    return this.request<Record<string, unknown>>("POST", `presets/${encodeURIComponent(slug)}/chat/completions`, {
      body,
      inference: true,
    });
  }
  generationFeedback(body: Record<string, unknown>) {
    return this.request<Record<string, unknown>>("POST", "generation/feedback", { body });
  }
  generationContent(query: Record<string, string | number | undefined> = {}) {
    return this.request<Record<string, unknown>>("GET", "generation/content", { query });
  }

  // Catalog sub-lists and public reference data
  speechModels() {
    return this.request<{ data: unknown[] }>("GET", "audio/speech/models");
  }
  speechModel(id: string) {
    const [author, slug] = id.split("/");
    if (!author || !slug) throw new Error(`OpenRouter model id must be "author/slug", got "${id}"`);
    return this.request<Record<string, unknown>>("GET", `audio/speech/models/${encodeURIComponent(author)}/${encodeURIComponent(slug)}`);
  }
  embeddingsModels() {
    return this.request<{ data: unknown[] }>("GET", "embeddings/models");
  }
  imagesModels() {
    return this.request<{ data: unknown[] }>("GET", "images/models");
  }
  videosModels() {
    return this.request<{ data: unknown[] }>("GET", "videos/models");
  }
  modelsCount() {
    return this.request<Record<string, unknown>>("GET", "models/count");
  }
  modelsUser() {
    return this.request<{ data: unknown[] }>("GET", "models/user");
  }
  providers() {
    return this.request<{ data: unknown[] }>("GET", "providers");
  }
  listTools() {
    return this.request<{ data: unknown[] }>("GET", "tools");
  }
  getTool(name: string) {
    return this.request<Record<string, unknown>>("GET", `tools/${encodeURIComponent(name)}`);
  }
  benchmarks() {
    return this.request<Record<string, unknown>>("GET", "benchmarks");
  }
  taskClassifications() {
    return this.request<Record<string, unknown>>("GET", "classifications/task");
  }
  videoContent(jobId: string) {
    return this.request<string>("GET", `videos/${encodeURIComponent(jobId)}/content`, { raw: true });
  }

  // Workspaces (management key)
  listWorkspaces() {
    return this.request<{ data: unknown[] }>("GET", "workspaces");
  }
  createWorkspace(body: Record<string, unknown>) {
    return this.request<Record<string, unknown>>("POST", "workspaces", { body });
  }
  getWorkspace(id: string) {
    return this.request<Record<string, unknown>>("GET", `workspaces/${encodeURIComponent(id)}`);
  }
  updateWorkspace(id: string, body: Record<string, unknown>) {
    return this.request<Record<string, unknown>>("PATCH", `workspaces/${encodeURIComponent(id)}`, { body });
  }
  deleteWorkspace(id: string) {
    return this.request<Record<string, unknown>>("DELETE", `workspaces/${encodeURIComponent(id)}`);
  }
  addWorkspaceMembers(id: string, body: Record<string, unknown>) {
    return this.request<Record<string, unknown>>("POST", `workspaces/${encodeURIComponent(id)}/members/add`, { body });
  }
  listWorkspaceBudgets(ref: string) {
    return this.request<Record<string, unknown>>("GET", `workspaces/${encodeURIComponent(ref)}/budgets`);
  }
  getWorkspaceBudget(ref: string, interval: string) {
    return this.request<Record<string, unknown>>(
      "GET",
      `workspaces/${encodeURIComponent(ref)}/budgets/${encodeURIComponent(interval)}`,
    );
  }

  // Organization (management key)
  orgMembers() {
    return this.request<{ data: unknown[] }>("GET", "organization/members");
  }
  orgSettings() {
    return this.request<Record<string, unknown>>("GET", "organization/settings");
  }
  updateOrgSettings(body: Record<string, unknown>) {
    return this.request<Record<string, unknown>>("PATCH", "organization/settings", { body });
  }

  // External users (management key)
  listExternalUsers(query: Record<string, string | number | undefined> = {}) {
    return this.request<{ data: unknown[] }>("GET", "external-users", { query });
  }
  createExternalUser(body: Record<string, unknown>) {
    return this.request<Record<string, unknown>>("POST", "external-users", { body });
  }
  getExternalUser(user: string) {
    return this.request<Record<string, unknown>>("GET", `external-users/${encodeURIComponent(user)}`);
  }

  // Guardrails (management key)
  listGuardrails() {
    return this.request<{ data: unknown[] }>("GET", "guardrails");
  }
  createGuardrail(body: Record<string, unknown>) {
    return this.request<Record<string, unknown>>("POST", "guardrails", { body });
  }
  getGuardrail(id: string) {
    return this.request<Record<string, unknown>>("GET", `guardrails/${encodeURIComponent(id)}`);
  }
  updateGuardrail(id: string, body: Record<string, unknown>) {
    return this.request<Record<string, unknown>>("PATCH", `guardrails/${encodeURIComponent(id)}`, { body });
  }
  deleteGuardrail(id: string) {
    return this.request<Record<string, unknown>>("DELETE", `guardrails/${encodeURIComponent(id)}`);
  }

  // Observability destinations (management key)
  listObservabilityDestinations() {
    return this.request<{ data: unknown[] }>("GET", "observability/destinations");
  }
  createObservabilityDestination(body: Record<string, unknown>) {
    return this.request<Record<string, unknown>>("POST", "observability/destinations", { body });
  }
  deleteObservabilityDestination(id: string) {
    return this.request<Record<string, unknown>>("DELETE", `observability/destinations/${encodeURIComponent(id)}`);
  }

  // Private endpoints / providers (management key)
  listPrivateEndpoints() {
    return this.request<{ data: unknown[] }>("GET", "private-endpoints");
  }
  createPrivateEndpoint(body: Record<string, unknown>) {
    return this.request<Record<string, unknown>>("POST", "private-endpoints", { body });
  }
  privateEndpointAction(id: string, action: "activate" | "disable" | "enable" | "validate") {
    // Four separate spec paths (/private-endpoints/{id}/activate etc.).
    return this.request<Record<string, unknown>>(
      "POST",
      `private-endpoints/${encodeURIComponent(id)}/${action}`,
      { body: {} },
    );
  }
  deletePrivateEndpoint(id: string) {
    return this.request<Record<string, unknown>>("DELETE", `private-endpoints/${encodeURIComponent(id)}`);
  }
  listPrivateProviders() {
    return this.request<{ data: unknown[] }>("GET", "private-providers");
  }
  createPrivateProvider(body: Record<string, unknown>) {
    return this.request<Record<string, unknown>>("POST", "private-providers", { body });
  }
  deletePrivateProvider(slug: string) {
    return this.request<Record<string, unknown>>("DELETE", `private-providers/${encodeURIComponent(slug)}`);
  }

  // Container files (code-execution containers)
  listContainerFiles(containerId: string) {
    return this.request<{ data: unknown[] }>("GET", `containers/${encodeURIComponent(containerId)}/files`);
  }
  getContainerFile(containerId: string, fileId: string) {
    return this.request<Record<string, unknown>>(
      "GET",
      `containers/${encodeURIComponent(containerId)}/files/${encodeURIComponent(fileId)}`,
    );
  }
  containerFileContent(containerId: string, fileId: string) {
    return this.request<string>(
      "GET",
      `containers/${encodeURIComponent(containerId)}/files/${encodeURIComponent(fileId)}/content`,
      { raw: true },
    );
  }
  promoteContainerFile(containerId: string, fileId: string) {
    return this.request<Record<string, unknown>>(
      "POST",
      `containers/${encodeURIComponent(containerId)}/files/${encodeURIComponent(fileId)}/promote`,
      { body: {} },
    );
  }

  // Alpha services
  alphaDecisions(body: Record<string, unknown>) {
    return this.request<Record<string, unknown>>("POST", "api/alpha/decisions", { body, inference: true });
  }
  alphaExtractions(body: Record<string, unknown>) {
    return this.request<Record<string, unknown>>("POST", "api/alpha/extractions", { body, inference: true });
  }
}

export function openRouterClient(): { client: OpenRouterClient } | { error: string } {
  if (!process.env.OPENROUTER_API_KEY) {
    return {
      error:
        "OpenRouter is not configured. Set OPENROUTER_API_KEY in the environment (a key from https://openrouter.ai/keys; management features need a management key).",
    };
  }
  return { client: new OpenRouterClient() };
}

function wrap(e: unknown) {
  return { ok: false as const, error: safeErrorMessage(e, "OpenRouter request failed") };
}

const modelId = z
  .string()
  .describe("OpenRouter model slug, e.g. 'openai/gpt-6-astra' or 'anthropic/claude-sonnet-5.5'");

// Canonical tool registry: contract operations in openrouter.openapi.yaml must
// match these names exactly (pinned by scripts/check-openrouter-contract.mjs).
export const OR_TOOLS: { name: string; description: string; endpoint: string }[] = [
  { name: "chat", description: "Chat completion with model fallbacks, provider routing and usage accounting", endpoint: "POST /chat/completions" },
  { name: "embed", description: "Embed text or documents via the embeddings router", endpoint: "POST /embeddings" },
  { name: "rerank", description: "Rerank documents against a query", endpoint: "POST /rerank" },
  { name: "models", description: "Search the model catalog (pricing, context, modality, providers)", endpoint: "GET /models" },
  { name: "model", description: "Full model detail by slug", endpoint: "GET /model/{author}/{slug}" },
  { name: "model_endpoints", description: "Upstream provider endpoints for a model", endpoint: "GET /models/{author}/{slug}/endpoints" },
  { name: "credits", description: "Credit balance and usage totals", endpoint: "GET /credits" },
  { name: "credit_purchases", description: "List credit purchases", endpoint: "GET /credits/purchases" },
  { name: "generation", description: "Cost and token accounting for one generation id", endpoint: "GET /generation?id=" },
  { name: "activity", description: "Usage activity grouped by model/key/day", endpoint: "GET /activity" },
  { name: "analytics_meta", description: "Analytics dimensions available for querying", endpoint: "GET /analytics/meta" },
  { name: "analytics_query", description: "Query usage analytics with dimension filters", endpoint: "POST /analytics/query" },
  { name: "key_info", description: "Limits, budgets and rate limits of the current key", endpoint: "GET /key" },
  { name: "keys_list", description: "List provisioning keys (management key)", endpoint: "GET /keys" },
  { name: "keys_create", description: "Create a provisioning key with limit and expiry", endpoint: "POST /keys" },
  { name: "keys_update", description: "Update a provisioning key's limit, label or expiry", endpoint: "PATCH /keys/{hash}" },
  { name: "keys_delete", description: "Delete a provisioning key", endpoint: "DELETE /keys/{hash}" },
  { name: "byok_list", description: "List bring-your-own provider keys", endpoint: "GET /byok" },
  { name: "byok_add", description: "Add a provider key to route through your own account", endpoint: "POST /byok" },
  { name: "byok_delete", description: "Remove a BYOK provider key", endpoint: "DELETE /byok/{id}" },
  { name: "files_list", description: "List uploaded files", endpoint: "GET /files" },
  { name: "files_upload", description: "Upload a file (base64 content) for batch or context use", endpoint: "POST /files" },
  { name: "files_metadata", description: "Read file metadata", endpoint: "GET /files/{file_id}" },
  { name: "files_content", description: "Download file content", endpoint: "GET /files/{file_id}/content" },
  { name: "files_delete", description: "Delete a file", endpoint: "DELETE /files/{file_id}" },
  { name: "batches_list", description: "List batch jobs", endpoint: "GET /batches" },
  { name: "batches_create", description: "Create a batch job from an uploaded input file", endpoint: "POST /batches" },
  { name: "batches_get", description: "Get batch job status and results", endpoint: "GET /batches/{id}" },
  { name: "batches_delete", description: "Cancel/delete a batch job", endpoint: "DELETE /batches/{id}" },
  { name: "transcribe", description: "Transcribe an audio file (base64) to text", endpoint: "POST /audio/transcriptions" },
  { name: "speech", description: "Text-to-speech audio generation (base64 data URL result)", endpoint: "POST /audio/speech" },
  { name: "image", description: "Generate an image from a prompt (base64/data URL result)", endpoint: "POST /images" },
  { name: "video_create", description: "Start a video generation job", endpoint: "POST /videos" },
  { name: "video_status", description: "Poll a video generation job until ready", endpoint: "GET /videos/{jobId}" },
  { name: "presets_list", description: "List saved prompt presets", endpoint: "GET /presets" },
  { name: "preset_get", description: "Get one preset", endpoint: "GET /presets/{slug}" },
  { name: "preset_delete", description: "Delete a preset", endpoint: "DELETE /presets/{slug}" },
  // Second wave: Responses/Messages APIs, catalog sub-lists, enterprise management
  { name: "responses", description: "OpenRouter Responses API: model output from an input string or item list", endpoint: "POST /responses" },
  { name: "messages", description: "Anthropic-style Messages API inference", endpoint: "POST /messages" },
  { name: "preset_chat", description: "Run a chat completion with a preset's saved settings", endpoint: "POST /presets/{slug}/chat/completions" },
  { name: "generation_feedback", description: "Submit feedback (good/bad) on a generation", endpoint: "POST /generation/feedback" },
  { name: "generation_content", description: "List generated content records", endpoint: "GET /generation/content" },
  { name: "speech_models", description: "List speech (TTS) models", endpoint: "GET /audio/speech/models" },
  { name: "speech_model", description: "Speech model detail", endpoint: "GET /audio/speech/models/{author}/{slug}" },
  { name: "embeddings_models", description: "List embedding models", endpoint: "GET /embeddings/models" },
  { name: "images_models", description: "List image models", endpoint: "GET /images/models" },
  { name: "videos_models", description: "List video models", endpoint: "GET /videos/models" },
  { name: "models_count", description: "Count of catalog models", endpoint: "GET /models/count" },
  { name: "models_user", description: "Models the authenticated account can use", endpoint: "GET /models/user" },
  { name: "providers", description: "List upstream providers", endpoint: "GET /providers" },
  { name: "tools_list", description: "List tool definitions", endpoint: "GET /tools" },
  { name: "tool_get", description: "Get one tool definition by name", endpoint: "GET /tools/{name}" },
  { name: "benchmarks", description: "Model benchmark data", endpoint: "GET /benchmarks" },
  { name: "classifications_task", description: "Task classifications", endpoint: "GET /classifications/task" },
  { name: "video_content", description: "Download finished video content", endpoint: "GET /videos/{jobId}/content" },
  { name: "workspaces_list", description: "List workspaces (management key)", endpoint: "GET /workspaces" },
  { name: "workspaces_create", description: "Create a workspace", endpoint: "POST /workspaces" },
  { name: "workspace_get", description: "Get one workspace", endpoint: "GET /workspaces/{id}" },
  { name: "workspace_update", description: "Update a workspace", endpoint: "PATCH /workspaces/{id}" },
  { name: "workspace_delete", description: "Delete a workspace", endpoint: "DELETE /workspaces/{id}" },
  { name: "workspace_members_add", description: "Bulk-add members to a workspace", endpoint: "POST /workspaces/{id}/members/add" },
  { name: "workspace_budgets", description: "List workspace budgets", endpoint: "GET /workspaces/{workspace_ref}/budgets" },
  { name: "workspace_budget", description: "Get a workspace budget by interval", endpoint: "GET /workspaces/{workspace_ref}/budgets/{interval}" },
  { name: "org_members", description: "List organization members (management key)", endpoint: "GET /organization/members" },
  { name: "org_settings", description: "Get organization settings", endpoint: "GET /organization/settings" },
  { name: "org_settings_update", description: "Update organization settings", endpoint: "PATCH /organization/settings" },
  { name: "external_users_list", description: "List external users", endpoint: "GET /external-users" },
  { name: "external_users_create", description: "Create an external user", endpoint: "POST /external-users" },
  { name: "external_user_get", description: "Get one external user", endpoint: "GET /external-users/{user}" },
  { name: "guardrails_list", description: "List guardrails (management key)", endpoint: "GET /guardrails" },
  { name: "guardrails_create", description: "Create a guardrail", endpoint: "POST /guardrails" },
  { name: "guardrail_get", description: "Get one guardrail", endpoint: "GET /guardrails/{id}" },
  { name: "guardrail_update", description: "Update a guardrail", endpoint: "PATCH /guardrails/{id}" },
  { name: "guardrail_delete", description: "Delete a guardrail", endpoint: "DELETE /guardrails/{id}" },
  { name: "observability_list", description: "List observability destinations (OTel endpoints)", endpoint: "GET /observability/destinations" },
  { name: "observability_create", description: "Create an observability destination", endpoint: "POST /observability/destinations" },
  { name: "observability_delete", description: "Delete an observability destination", endpoint: "DELETE /observability/destinations/{id}" },
  { name: "private_endpoints_list", description: "List private endpoints", endpoint: "GET /private-endpoints" },
  { name: "private_endpoints_create", description: "Create a private endpoint", endpoint: "POST /private-endpoints" },
  { name: "private_endpoint_action", description: "Activate/disable/enable/validate a private endpoint", endpoint: "POST /private-endpoints/{id}/activate|disable|enable|validate" },
  { name: "private_endpoint_delete", description: "Delete a private endpoint", endpoint: "DELETE /private-endpoints/{id}" },
  { name: "private_providers_list", description: "List private providers", endpoint: "GET /private-providers" },
  { name: "private_providers_create", description: "Create a private provider", endpoint: "POST /private-providers" },
  { name: "private_provider_delete", description: "Delete a private provider", endpoint: "DELETE /private-providers/{slug}" },
  { name: "container_files_list", description: "List files in a code-execution container", endpoint: "GET /containers/{container_id}/files" },
  { name: "container_file_get", description: "Get container file metadata", endpoint: "GET /containers/{container_id}/files/{file_id}" },
  { name: "container_file_content", description: "Download container file content", endpoint: "GET /containers/{container_id}/files/{file_id}/content" },
  { name: "container_file_promote", description: "Promote a container file to persistent storage", endpoint: "POST /containers/{container_id}/files/{file_id}/promote" },
  { name: "alpha_decisions", description: "Alpha: AI-assisted decisions", endpoint: "POST /api/alpha/decisions" },
  { name: "alpha_extractions", description: "Alpha: structured data extraction", endpoint: "POST /api/alpha/extractions" },
  { name: "request", description: "Raw authenticated request to any OpenRouter API path (escape hatch for endpoints without a dedicated tool)", endpoint: "ANY /{path}" },
];

export function buildOpenRouterTools(): Record<string, Tool> {
  const cfg = openRouterClient();
  if ("error" in cfg) return {}; // no key: register nothing, like every other surface
  const or = cfg.client;

  const tools: Record<string, Tool> = {
    or_chat: tool({
      description:
        "Run one chat completion through OpenRouter with a model of your choice. Supports model fallbacks, provider routing, JSON mode and usage accounting. Returns the message content plus token/cost usage.",
      inputSchema: z.object({
        model: modelId,
        models: z.array(z.string()).optional().describe("Fallback model slugs tried in order"),
        messages: z
          .array(z.object({ role: z.enum(["system", "user", "assistant", "tool"]), content: z.string() }))
          .describe("Conversation messages"),
        max_tokens: z.number().int().positive().optional(),
        temperature: z.number().min(0).max(2).optional(),
        top_p: z.number().min(0).max(1).optional(),
        json_mode: z.boolean().optional().describe("Force a JSON object response via response_format"),
        route: z.enum(["fallback", "room"]).optional(),
        provider_order: z.array(z.string()).optional().describe("Preferred upstream providers in order"),
        allow_fallbacks: z.boolean().optional().describe("Whether provider routing may fall back to other providers"),
        usage: z.boolean().optional().describe("Include token accounting in the response"),
      }),
      execute: async (p) => {
        try {
          const body: Record<string, unknown> = {
            model: p.model,
            messages: p.messages,
            usage: p.usage ?? true,
          };
          if (p.models?.length) body.models = p.models;
          if (p.max_tokens !== undefined) body.max_tokens = p.max_tokens;
          if (p.temperature !== undefined) body.temperature = p.temperature;
          if (p.top_p !== undefined) body.top_p = p.top_p;
          if (p.json_mode) body.response_format = { type: "json_object" };
          if (p.route) body.route = p.route;
          if (p.provider_order?.length || p.allow_fallbacks !== undefined) {
            body.provider = {
              ...(p.provider_order?.length ? { order: p.provider_order } : {}),
              ...(p.allow_fallbacks !== undefined ? { allow_fallbacks: p.allow_fallbacks } : {}),
            };
          }
          const res = await or.chatCompletion(body);
          const choice = (res.choices as { message?: { content?: unknown } }[] | undefined)?.[0];
          return { ok: true as const, content: choice?.message?.content ?? null, usage: res.usage ?? null, id: res.id ?? null };
        } catch (e) {
          return wrap(e);
        }
      },
    }),
    or_embed: tool({
      description:
        "Create embeddings for one string or a list of strings with an OpenRouter embedding model (e.g. openai/text-embedding-3-small).",
      inputSchema: z.object({
        model: modelId,
        input: z.union([z.string(), z.array(z.string())]).describe("Text or list of texts to embed"),
        dimensions: z.number().int().positive().optional(),
        encoding_format: z.enum(["float", "base64"]).optional(),
      }),
      execute: async (p) => {
        try {
          const body: Record<string, unknown> = { model: p.model, input: p.input };
          if (p.dimensions !== undefined) body.dimensions = p.dimensions;
          if (p.encoding_format) body.encoding_format = p.encoding_format;
          return { ok: true as const, ...(await or.embeddings(body)) };
        } catch (e) {
          return wrap(e);
        }
      },
    }),
    or_rerank: tool({
      description:
        "Rerank a list of documents against a query for relevance, returning per-document scores in ranked order.",
      inputSchema: z.object({
        model: modelId.describe("Rerank model slug, e.g. 'cohere/rerank-v3.5'"),
        query: z.string(),
        documents: z.array(z.string()).min(1).max(1000),
        top_n: z.number().int().positive().optional(),
      }),
      execute: async (p) => {
        try {
          const body: Record<string, unknown> = { model: p.model, query: p.query, documents: p.documents };
          if (p.top_n !== undefined) body.top_n = p.top_n;
          return { ok: true as const, ...(await or.rerank(body)) };
        } catch (e) {
          return wrap(e);
        }
      },
    }),
    or_models: tool({
      description:
        "Search the OpenRouter model catalog. Filter by search text, modality or free status; returns pricing, context length, modality and providers per model.",
      inputSchema: z.object({
        search: z.string().optional().describe("Match model id/name substring"),
        modality: z.string().optional().describe("e.g. 'text->text', 'text->image', 'image->text'"),
        free: z.boolean().optional().describe("Only models with prompt price 0"),
        max_results: z.number().int().min(1).max(200).optional(),
      }),
      execute: async (p) => {
        try {
          const res = await or.models();
          let rows = Array.isArray(res.data) ? (res.data as Record<string, unknown>[]) : [];
          if (p.search) {
            const q = p.search.toLowerCase();
            rows = rows.filter((m) => `${m.id ?? ""} ${m.name ?? ""}`.toLowerCase().includes(q));
          }
          if (p.modality) {
            rows = rows.filter((m) => (m.architecture as { modality?: string } | null)?.modality === p.modality);
          }
          if (p.free) {
            rows = rows.filter((m) => (m.pricing as { prompt?: string } | undefined)?.prompt === "0");
          }
          const cap = p.max_results ?? 50;
          return { ok: true as const, count: rows.length, truncated: rows.length > cap, models: rows.slice(0, cap) };
        } catch (e) {
          return wrap(e);
        }
      },
    }),
    or_model: tool({
      description:
        "Full detail for one OpenRouter model: pricing, context window, modality, token limits and supported parameters.",
      inputSchema: z.object({ model: modelId }),
      execute: async (p) => {
        try {
          return { ok: true as const, ...(await or.model(p.model)) };
        } catch (e) {
          return wrap(e);
        }
      },
    }),
    or_model_endpoints: tool({
      description:
        "List the upstream provider endpoints for a model (per-provider pricing, uptime, context, quantization).",
      inputSchema: z.object({ model: modelId }),
      execute: async (p) => {
        try {
          return { ok: true as const, ...(await or.modelEndpoints(p.model)) };
        } catch (e) {
          return wrap(e);
        }
      },
    }),
    or_credits: tool({
      description: "Get the OpenRouter credit balance, total usage and remaining credits.",
      inputSchema: z.object({}),
      execute: async () => {
        try {
          return { ok: true as const, ...(await or.credits()) };
        } catch (e) {
          return wrap(e);
        }
      },
    }),
    or_credit_purchases: tool({
      description: "List credit purchase history.",
      inputSchema: z.object({
        limit: z.number().int().min(1).max(100).optional(),
        offset: z.number().int().min(0).optional(),
      }),
      execute: async (p) => {
        try {
          return { ok: true as const, ...(await or.creditPurchases(p)) };
        } catch (e) {
          return wrap(e);
        }
      },
    }),
    or_generation: tool({
      description: "Look up the cost, tokens and provider for one generation id (the id returned by a chat completion).",
      inputSchema: z.object({ id: z.string().describe("Generation id, e.g. 'gen-123456'") }),
      execute: async (p) => {
        try {
          return { ok: true as const, ...(await or.generation(p.id)) };
        } catch (e) {
          return wrap(e);
        }
      },
    }),
    or_activity: tool({
      description: "Usage activity for the account over a date range, grouped by model, key or day.",
      inputSchema: z.object({
        date_from: z.string().optional().describe("YYYY-MM-DD inclusive"),
        date_to: z.string().optional().describe("YYYY-MM-DD exclusive"),
        var_usd: z.boolean().optional(),
        output: z.string().optional().describe("Output grouping field from analytics_meta"),
      }),
      execute: async (p) => {
        try {
          return { ok: true as const, ...(await or.activity(p)) };
        } catch (e) {
          return wrap(e);
        }
      },
    }),
    or_analytics_meta: tool({
      description: "List the dimensions and metrics available for analytics queries.",
      inputSchema: z.object({}),
      execute: async () => {
        try {
          return { ok: true as const, ...(await or.analyticsMeta()) };
        } catch (e) {
          return wrap(e);
        }
      },
    }),
    or_analytics_query: tool({
      description: "Query usage analytics (spend, tokens, requests) with dimension grouping and filters.",
      inputSchema: z.object({
        datasets: z.array(z.string()).describe("Dataset names from analytics_meta, e.g. 'usage'"),
        dimension: z.string().optional().describe("Group-by dimension, e.g. 'model', 'key', 'date'"),
        time_range: z.string().optional().describe("e.g. 'last_7_days'"),
        filters: z.array(z.object({ field: z.string(), op: z.string(), value: z.string() })).optional(),
      }),
      execute: async (p) => {
        try {
          return { ok: true as const, ...(await or.analyticsQuery(p)) };
        } catch (e) {
          return wrap(e);
        }
      },
    }),
    or_key_info: tool({
      description: "Limits, budgets, rate limits and free-tier status of the current API key.",
      inputSchema: z.object({}),
      execute: async () => {
        try {
          return { ok: true as const, ...(await or.currentKey()) };
        } catch (e) {
          return wrap(e);
        }
      },
    }),
    or_keys_list: tool({
      description: "List provisioning keys on the account (requires a management key).",
      inputSchema: z.object({
        include_disabled: z.boolean().optional(),
        offset: z.number().int().min(0).optional(),
        limit: z.number().int().min(1).max(1000).optional(),
      }),
      execute: async (p) => {
        try {
          return { ok: true as const, ...(await or.listKeys(p)) };
        } catch (e) {
          return wrap(e);
        }
      },
    }),
    or_keys_create: tool({
      description: "Create a provisioning key with an optional spend limit, expiry and name.",
      inputSchema: z.object({
        name: z.string().optional(),
        limit: z.number().optional().describe("Spend limit in USD"),
        expires_at: z.string().optional().describe("ISO date-time"),
        allow_console: z.boolean().optional(),
      }),
      execute: async (p) => {
        try {
          return { ok: true as const, ...(await or.createKey(p)) };
        } catch (e) {
          return wrap(e);
        }
      },
    }),
    or_keys_update: tool({
      description: "Update a provisioning key's spend limit, label, expiry or disabled state.",
      inputSchema: z.object({
        hash: z.string(),
        name: z.string().optional(),
        limit: z.number().nullable().optional(),
        expires_at: z.string().nullable().optional(),
        disabled: z.boolean().optional(),
      }),
      execute: async (p) => {
        try {
          const { hash, ...body } = p;
          return { ok: true as const, ...(await or.updateKey(hash, body)) };
        } catch (e) {
          return wrap(e);
        }
      },
    }),
    or_keys_delete: tool({
      description: "Delete a provisioning key by hash.",
      inputSchema: z.object({ hash: z.string() }),
      execute: async (p) => {
        try {
          return { ok: true as const, ...(await or.deleteKey(p.hash)) };
        } catch (e) {
          return wrap(e);
        }
      },
    }),
    or_byok_list: tool({
      description: "List bring-your-own provider keys configured on the account.",
      inputSchema: z.object({}),
      execute: async () => {
        try {
          return { ok: true as const, ...(await or.listByok()) };
        } catch (e) {
          return wrap(e);
        }
      },
    }),
    or_byok_add: tool({
      description: "Add a provider key so OpenRouter routes that provider's models through your own upstream account.",
      inputSchema: z.object({
        provider: z.string().describe("Provider slug, e.g. 'openai', 'anthropic', 'google-vertex'"),
        api_key: z.string(),
        name: z.string().optional(),
      }),
      execute: async (p) => {
        try {
          return { ok: true as const, ...(await or.addByok(p)) };
        } catch (e) {
          return wrap(e);
        }
      },
    }),
    or_byok_delete: tool({
      description: "Remove a BYOK provider key by id.",
      inputSchema: z.object({ id: z.string() }),
      execute: async (p) => {
        try {
          return { ok: true as const, ...(await or.deleteByok(p.id)) };
        } catch (e) {
          return wrap(e);
        }
      },
    }),
    or_files_list: tool({
      description: "List files uploaded to OpenRouter (batch inputs, context files).",
      inputSchema: z.object({
        limit: z.number().int().min(1).max(100).optional(),
        offset: z.number().int().min(0).optional(),
      }),
      execute: async (p) => {
        try {
          return { ok: true as const, ...(await or.listFiles(p)) };
        } catch (e) {
          return wrap(e);
        }
      },
    }),
    or_files_upload: tool({
      description: "Upload a file (base64 content) for batch processing.",
      inputSchema: z.object({
        name: z.string(),
        content_base64: z.string().describe("Base64-encoded file content"),
        purpose: z.string().optional().describe("e.g. 'batch'"),
      }),
      execute: async (p) => {
        try {
          return { ok: true as const, ...(await or.uploadFile(p.name, p.content_base64, p.purpose || "batch")) };
        } catch (e) {
          return wrap(e);
        }
      },
    }),
    or_files_metadata: tool({
      description: "Read metadata for one uploaded file.",
      inputSchema: z.object({ id: z.string() }),
      execute: async (p) => {
        try {
          return { ok: true as const, ...(await or.fileMetadata(p.id)) };
        } catch (e) {
          return wrap(e);
        }
      },
    }),
    or_files_content: tool({
      description: "Download the content of one uploaded file as text.",
      inputSchema: z.object({ id: z.string() }),
      execute: async (p) => {
        try {
          return { ok: true as const, content: await or.fileContent(p.id) };
        } catch (e) {
          return wrap(e);
        }
      },
    }),
    or_files_delete: tool({
      description: "Delete an uploaded file by id.",
      inputSchema: z.object({ id: z.string() }),
      execute: async (p) => {
        try {
          return { ok: true as const, ...(await or.deleteFile(p.id)) };
        } catch (e) {
          return wrap(e);
        }
      },
    }),
    or_batches_list: tool({
      description: "List batch jobs with their statuses.",
      inputSchema: z.object({
        limit: z.number().int().min(1).max(100).optional(),
        offset: z.number().int().min(0).optional(),
      }),
      execute: async (p) => {
        try {
          return { ok: true as const, ...(await or.listBatches(p)) };
        } catch (e) {
          return wrap(e);
        }
      },
    }),
    or_batches_create: tool({
      description: "Create a batch job that runs an uploaded JSONL input file (chat completions) at a discount.",
      inputSchema: z.object({
        input_file_id: z.string().describe("File id from files_upload"),
        endpoint: z.string().optional().describe("e.g. '/v1/chat/completions'"),
        completion_window: z.string().optional(),
        metadata: z.record(z.string(), z.string()).optional(),
      }),
      execute: async (p) => {
        try {
          return { ok: true as const, ...(await or.createBatch(p)) };
        } catch (e) {
          return wrap(e);
        }
      },
    }),
    or_batches_get: tool({
      description: "Get a batch job's status, request counts and output file id.",
      inputSchema: z.object({ id: z.string() }),
      execute: async (p) => {
        try {
          return { ok: true as const, ...(await or.getBatch(p.id)) };
        } catch (e) {
          return wrap(e);
        }
      },
    }),
    or_batches_delete: tool({
      description: "Cancel or delete a batch job.",
      inputSchema: z.object({ id: z.string() }),
      execute: async (p) => {
        try {
          return { ok: true as const, ...(await or.deleteBatch(p.id)) };
        } catch (e) {
          return wrap(e);
        }
      },
    }),
    or_transcribe: tool({
      description: "Transcribe an audio file (base64 content) to text with an OpenRouter speech model.",
      inputSchema: z.object({
        model: modelId.describe("Transcription model, e.g. 'openai/gpt-4o-transcribe'"),
        filename: z.string().describe("Audio file name including extension, e.g. 'meeting.mp3'"),
        content_base64: z.string().describe("Base64-encoded audio"),
        language: z.string().optional(),
        prompt: z.string().optional(),
      }),
      execute: async (p) => {
        try {
          const bytes = Buffer.from(p.content_base64, "base64");
          const form = new FormData();
          form.append("model", p.model);
          form.append("file", new Blob([bytes]), p.filename);
          if (p.language) form.append("language", p.language);
          if (p.prompt) form.append("prompt", p.prompt);
          return { ok: true as const, ...(await or.transcriptions(form)) };
        } catch (e) {
          return wrap(e);
        }
      },
    }),
    or_speech: tool({
      description: "Generate spoken audio from text. Returns base64 audio as a data URL you can play or embed.",
      inputSchema: z.object({
        model: modelId.describe("Speech model, e.g. 'openai/gpt-4o-mini-tts'"),
        input: z.string().describe("Text to speak"),
        voice: z.string().optional().describe("e.g. 'alloy', 'verse'"),
        response_format: z.enum(["mp3", "wav", "opus", "aac", "flac", "pcm"]).optional(),
      }),
      execute: async (p) => {
        try {
          const body: Record<string, unknown> = { model: p.model, input: p.input };
          if (p.voice) body.voice = p.voice;
          if (p.response_format) body.response_format = p.response_format;
          const res = await or.speech(body);
          const b64 = (res as { audio?: { data?: string } }).audio?.data;
          return {
            ok: true as const,
            ...(b64 ? { audio_data_url: `data:audio/${p.response_format ?? "mp3"};base64,${b64}` } : {}),
            ...res,
          };
        } catch (e) {
          return wrap(e);
        }
      },
    }),
    or_image: tool({
      description: "Generate one or more images from a prompt. Returns base64 image data URLs.",
      inputSchema: z.object({
        model: modelId.describe("Image model, e.g. 'google/gemini-3-pro-image'"),
        prompt: z.string(),
        n: z.number().int().min(1).max(4).optional(),
        size: z.string().optional().describe("e.g. '1024x1024'"),
        response_format: z.enum(["b64_json", "url"]).optional(),
      }),
      execute: async (p) => {
        try {
          const body: Record<string, unknown> = { model: p.model, prompt: p.prompt };
          if (p.n !== undefined) body.n = p.n;
          if (p.size) body.size = p.size;
          if (p.response_format) body.response_format = p.response_format;
          return { ok: true as const, ...(await or.images(body)) };
        } catch (e) {
          return wrap(e);
        }
      },
    }),
    or_video_create: tool({
      description: "Start a video generation job from a prompt. Returns a job id to poll with video_status.",
      inputSchema: z.object({
        model: modelId.describe("Video model, e.g. 'google/veo-3.1'"),
        prompt: z.string(),
        aspect_ratio: z.string().optional().describe("e.g. '16:9'"),
        duration: z.number().optional().describe("Seconds"),
        resolution: z.string().optional().describe("e.g. '720p'"),
        image_url: z.string().optional().describe("First-frame image for image-to-video"),
      }),
      execute: async (p) => {
        try {
          return { ok: true as const, ...(await or.createVideo(p)) };
        } catch (e) {
          return wrap(e);
        }
      },
    }),
    or_video_status: tool({
      description: "Poll a video generation job; waits until the video is ready or failed (up to ~2 minutes).",
      inputSchema: z.object({ job_id: z.string() }),
      execute: async (p) => {
        try {
          return { ok: true as const, ...(await or.pollVideo(p.job_id)) };
        } catch (e) {
          return wrap(e);
        }
      },
    }),
    or_presets_list: tool({
      description: "List saved prompt presets (model + system prompt + sampling defaults).",
      inputSchema: z.object({
        limit: z.number().int().min(1).max(100).optional(),
        offset: z.number().int().min(0).optional(),
      }),
      execute: async (p) => {
        try {
          return { ok: true as const, ...(await or.listPresets(p)) };
        } catch (e) {
          return wrap(e);
        }
      },
    }),
    or_preset_get: tool({
      description: "Get one preset by slug.",
      inputSchema: z.object({ uid: z.string() }),
      execute: async (p) => {
        try {
          return { ok: true as const, ...(await or.getPreset(p.uid)) };
        } catch (e) {
          return wrap(e);
        }
      },
    }),
    or_preset_delete: tool({
      description: "Delete a preset by uid.",
      inputSchema: z.object({ uid: z.string() }),
      execute: async (p) => {
        try {
          return { ok: true as const, ...(await or.deletePreset(p.uid)) };
        } catch (e) {
          return wrap(e);
        }
      },
    }),
  };

  // Second wave. Uniform management endpoints are table-driven: each entry is
  // [tool name, client call]. Inference-shaped endpoints get typed tools below.
  const passthrough: Record<string, () => Promise<unknown>> = {
    or_speech_models: () => or.speechModels(),
    or_embeddings_models: () => or.embeddingsModels(),
    or_images_models: () => or.imagesModels(),
    or_videos_models: () => or.videosModels(),
    or_models_count: () => or.modelsCount(),
    or_models_user: () => or.modelsUser(),
    or_providers: () => or.providers(),
    or_tools_list: () => or.listTools(),
    or_benchmarks: () => or.benchmarks(),
    or_classifications_task: () => or.taskClassifications(),
    or_generation_content: () => or.generationContent(),
    or_workspaces_list: () => or.listWorkspaces(),
    or_workspace_budgets: () => or.listWorkspaceBudgets(String(passthroughArgs.workspace_ref ?? "")),
    or_org_members: () => or.orgMembers(),
    or_org_settings: () => or.orgSettings(),
    or_external_users_list: () => or.listExternalUsers(),
    or_guardrails_list: () => or.listGuardrails(),
    or_observability_list: () => or.listObservabilityDestinations(),
    or_private_endpoints_list: () => or.listPrivateEndpoints(),
    or_private_providers_list: () => or.listPrivateProviders(),
  };
  const passthroughArgs: Record<string, unknown> = {};
  for (const [name, fn] of Object.entries(passthrough)) {
    tools[name] = tool({
      description: OR_TOOLS.find((t) => `or_${t.name}` === name)?.description ?? name,
      inputSchema: z.object({}).passthrough().optional().describe("Optional query parameters"),
      execute: async (p) => {
        Object.assign(passthroughArgs, p ?? {});
        try {
          return { ok: true as const, ...((await fn()) as Record<string, unknown>) };
        } catch (e) {
          return wrap(e);
        }
      },
    });
  }

  const simple = <S extends z.ZodType>(
    name: string,
    inputSchema: S,
    fn: (p: z.output<S>) => Promise<unknown>,
  ) =>
    tool({
      description: OR_TOOLS.find((t) => `or_${t.name}` === name)?.description ?? name,
      inputSchema,
      execute: async (p) => {
        try {
          return { ok: true as const, ...((await fn(p as z.output<S>)) as Record<string, unknown>) };
        } catch (e) {
          return wrap(e);
        }
      },
    });

  Object.assign(tools, {
    or_speech_model: simple("or_speech_model", z.object({ id: z.string().describe("'author/slug'") }), (p) => or.speechModel(p.id)),
    or_tool_get: simple("or_tool_get", z.object({ name: z.string() }), (p) => or.getTool(p.name)),
    or_responses: simple(
      "or_responses",
      z.object({
        model: modelId.optional(),
        input: z.union([z.string(), z.array(z.record(z.string(), z.unknown()))]).describe("Input string or item list"),
        instructions: z.string().optional(),
        max_output_tokens: z.number().int().positive().optional(),
        stream: z.boolean().optional(),
        models: z.array(z.string()).optional(),
      }),
      (p) => or.responses(p),
    ),
    or_messages: simple(
      "or_messages",
      z.object({
        model: modelId,
        messages: z.array(z.object({ role: z.string(), content: z.unknown() })),
        max_tokens: z.number().int().positive().optional(),
        system: z.string().optional(),
        temperature: z.number().optional(),
      }),
      (p) => or.messagesApi(p),
    ),
    or_preset_chat: simple(
      "or_preset_chat",
      z.object({
        slug: z.string(),
        messages: z.array(z.object({ role: z.string(), content: z.string() })),
        max_tokens: z.number().int().positive().optional(),
        temperature: z.number().optional(),
      }),
      (p) => or.presetChat(p.slug, { messages: p.messages, max_tokens: p.max_tokens, temperature: p.temperature }),
    ),
    or_generation_feedback: simple(
      "or_generation_feedback",
      z.object({ id: z.string(), good: z.boolean().optional(), reason: z.string().optional() }),
      (p) => or.generationFeedback(p),
    ),
    or_workspaces_create: simple("or_workspaces_create", z.object({ name: z.string() }), (p) => or.createWorkspace(p)),
    or_workspace_get: simple("or_workspace_get", z.object({ id: z.string() }), (p) => or.getWorkspace(p.id)),
    or_workspace_update: simple(
      "or_workspace_update",
      z.object({ id: z.string(), name: z.string().optional() }),
      (p) => or.updateWorkspace(p.id, { name: p.name }),
    ),
    or_workspace_delete: simple("or_workspace_delete", z.object({ id: z.string() }), (p) => or.deleteWorkspace(p.id)),
    or_workspace_members_add: simple(
      "or_workspace_members_add",
      z.object({ id: z.string(), members: z.array(z.string()) }),
      (p) => or.addWorkspaceMembers(p.id, { members: p.members }),
    ),
    or_workspace_budget: simple(
      "or_workspace_budget",
      z.object({ workspace_ref: z.string(), interval: z.string() }),
      (p) => or.getWorkspaceBudget(p.workspace_ref, p.interval),
    ),
    or_org_settings_update: simple(
      "or_org_settings_update",
      z.object({}).passthrough(),
      (p) => or.updateOrgSettings(p),
    ),
    or_external_users_create: simple(
      "or_external_users_create",
      z.object({ user: z.string(), label: z.string().optional() }).passthrough(),
      (p) => or.createExternalUser(p),
    ),
    or_external_user_get: simple("or_external_user_get", z.object({ user: z.string() }), (p) => or.getExternalUser(p.user)),
    or_guardrails_create: simple(
      "or_guardrails_create",
      z.object({}).passthrough().describe("Guardrail configuration per the OpenRouter docs"),
      (p) => or.createGuardrail(p),
    ),
    or_guardrail_get: simple("or_guardrail_get", z.object({ id: z.string() }), (p) => or.getGuardrail(p.id)),
    or_guardrail_update: simple(
      "or_guardrail_update",
      z.object({ id: z.string() }).passthrough(),
      (p) => {
        const { id, ...body } = p;
        return or.updateGuardrail(id, body);
      },
    ),
    or_guardrail_delete: simple("or_guardrail_delete", z.object({ id: z.string() }), (p) => or.deleteGuardrail(p.id)),
    or_observability_create: simple(
      "or_observability_create",
      z.object({ name: z.string(), endpoint: z.string() }).passthrough(),
      (p) => or.createObservabilityDestination(p),
    ),
    or_observability_delete: simple(
      "or_observability_delete",
      z.object({ id: z.string() }),
      (p) => or.deleteObservabilityDestination(p.id),
    ),
    or_private_endpoints_create: simple(
      "or_private_endpoints_create",
      z.object({}).passthrough(),
      (p) => or.createPrivateEndpoint(p),
    ),
    or_private_endpoint_action: simple(
      "or_private_endpoint_action",
      z.object({ id: z.string(), action: z.enum(["activate", "disable", "enable", "validate"]) }),
      (p) => or.privateEndpointAction(p.id, p.action),
    ),
    or_private_endpoint_delete: simple(
      "or_private_endpoint_delete",
      z.object({ id: z.string() }),
      (p) => or.deletePrivateEndpoint(p.id),
    ),
    or_private_providers_create: simple(
      "or_private_providers_create",
      z.object({}).passthrough(),
      (p) => or.createPrivateProvider(p),
    ),
    or_private_provider_delete: simple(
      "or_private_provider_delete",
      z.object({ slug: z.string() }),
      (p) => or.deletePrivateProvider(p.slug),
    ),
    or_container_files_list: simple(
      "or_container_files_list",
      z.object({ container_id: z.string() }),
      (p) => or.listContainerFiles(p.container_id),
    ),
    or_container_file_get: simple(
      "or_container_file_get",
      z.object({ container_id: z.string(), file_id: z.string() }),
      (p) => or.getContainerFile(p.container_id, p.file_id),
    ),
    or_container_file_content: simple(
      "or_container_file_content",
      z.object({ container_id: z.string(), file_id: z.string() }),
      (p) => or.containerFileContent(p.container_id, p.file_id),
    ),
    or_container_file_promote: simple(
      "or_container_file_promote",
      z.object({ container_id: z.string(), file_id: z.string() }),
      (p) => or.promoteContainerFile(p.container_id, p.file_id),
    ),
    or_alpha_decisions: simple("or_alpha_decisions", z.object({}).passthrough(), (p) => or.alphaDecisions(p)),
    or_alpha_extractions: simple("or_alpha_extractions", z.object({}).passthrough(), (p) => or.alphaExtractions(p)),
    or_video_content: simple(
      "or_video_content",
      z.object({ job_id: z.string() }),
      async (p) => {
        const raw = await or.videoContent(p.job_id);
        return { content: raw.slice(0, 2000) };
      },
    ),
  });

  // Escape hatch for any path without a dedicated tool. Opt-in so agents do
  // not get raw account-wide API access by default; not part of the contract.
  if (process.env.OR_ALLOW_RAW === "1") {
    tools.or_request = tool({
      description:
        "Raw authenticated request to any OpenRouter API path. Use for management endpoints without a dedicated tool.",
      inputSchema: z.object({
        method: z.enum(["GET", "POST", "PATCH", "DELETE"]),
        path: z.string().describe("Path relative to the API root, e.g. 'guardrails/123/assignments/keys'"),
        body: z.record(z.string(), z.unknown()).optional(),
        query: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
      }),
      execute: async (p) => {
        try {
          return { ok: true as const, ...(await or.request<Record<string, unknown>>(p.method, p.path, { body: p.body, query: p.query })) };
        } catch (e) {
          return wrap(e);
        }
      },
    });
  }

  return tools;
}
