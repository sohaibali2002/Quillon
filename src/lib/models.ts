// Provider configuration layer.
//
// Model ids are AI Gateway strings like "openai/gpt-6-astra" and are routed
// through the Vercel AI Gateway, authenticated with AI_GATEWAY_API_KEY.
// Direct provider packages can be added later; the id decides the route.
//
// Set AI_MOCK=1 to swap in scripted mock models (from `ai/test`) so the whole
// pipeline can be smoke-tested without any provider key.

import type { EmbeddingModel, LanguageModel } from "ai";

export const DEFAULT_MODEL =
  process.env.AI_DEFAULT_MODEL ?? "openai/gpt-6-astra";
export const DEFAULT_EMBEDDING_MODEL =
  process.env.AI_EMBEDDING_MODEL ?? "openai/text-embedding-4";

export type ModelId = string;

let languageMock: Promise<LanguageModel> | undefined;
let embeddingMock: Promise<EmbeddingModel> | undefined;

function mockUsage() {
  return {
    inputTokens: { total: 3, noCache: 3, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 10, text: 10, reasoning: 0 },
  };
}

// Scripted responses: structured-output prompts get schema-valid JSON so
// Output.object can parse them; everything else gets plain text.
function mockTextFor(promptText: string): string {
  const p = promptText.toLowerCase();
  if (p.includes("recipe") || p.includes("pasta")) {
    return JSON.stringify({
      name: "Mock Pasta",
      ingredients: ["200g pasta", "2 cloves garlic", "1 tbsp olive oil"],
      steps: ["Boil pasta", "Fry garlic in oil", "Toss together"],
      servings: 2,
    });
  }
  if (p.includes("summar")) {
    return JSON.stringify({
      summary: "Mock summary (AI_MOCK=1).",
      toolsUsed: [],
      confidence: 0.9,
    });
  }
  if (p.includes("worker results:")) {
    return "Combined findings from the workers' subtask results (AI_MOCK=1).";
  }
  return "Mock reply (AI_MOCK=1): the pipeline works.";
}

// Output.array expects the model text to parse as { elements: [...] } (verified
// against ai 7's parseCompleteOutput), so when the responseFormat schema asks
// for an elements array, produce deterministic schema-valid elements.
function mockArrayTextFor(options: {
  responseFormat?: { type: "text" } | { type: "json"; schema?: unknown };
}): string | undefined {
  const format = options.responseFormat;
  if (format?.type !== "json") return undefined;
  const schema = format.schema as
    | { properties?: { elements?: { items?: { properties?: Record<string, unknown> } } } }
    | undefined;
  const items = schema?.properties?.elements?.items;
  const firstKey = Object.keys(items?.properties ?? {})[0];
  if (!firstKey) return undefined;
  const elements = [1, 2, 3].map((n) => ({ [firstKey]: `Mock ${firstKey} ${n}` }));
  return JSON.stringify({ elements });
}

// Generic mock for arbitrary object schemas (Output.object): build schema-valid
// JSON from the schema's properties, so any structured stage runs in mock mode.
function mockValueFor(key: string, prop: unknown, depth = 0): unknown {
  const p = (prop ?? {}) as {
    type?: string;
    enum?: unknown[];
    minimum?: number;
    maximum?: number;
    items?: unknown;
    properties?: Record<string, unknown>;
  };
  if (p.enum?.length) return p.enum[0];
  const k = key.toLowerCase();
  if (p.type === "boolean") return true;
  if (p.type === "number" || p.type === "integer") {
    const min = p.minimum ?? 0;
    const max = p.maximum ?? (p.minimum !== undefined ? Math.max(min + 1, min) : 5);
    return Math.min(max, Math.max(min, min === 0 && max === 1 ? 0.9 : max - 1));
  }
  if (p.type === "array") {
    const items = p.items;
    if (depth < 3 && typeof items === "object" && items !== null) {
      const item = items as { type?: string; properties?: Record<string, unknown> };
      if (item.properties) return [0, 1].map(() => mockObjectFrom(item.properties!, depth + 1));
      if (item.type === "string") return [`Mock ${key} 1`, `Mock ${key} 2`];
    }
    return [`Mock ${key} 1`];
  }
  // string (default)
  if (k.includes("title")) return `Mock ${key}`;
  if (k.includes("summar") || k.includes("synthes")) {
    return "Combined findings from the subtasks (AI_MOCK=1).";
  }
  if (k.includes("explain") || k.includes("describ") || k.includes("reason")) {
    return `How this ${key} was produced (AI_MOCK=1).`;
  }
  if (k.includes("path") || k.includes("file")) return "src/mock.ts";
  return `Mock ${key} content (AI_MOCK=1).`;
}

function mockObjectFrom(properties: Record<string, unknown>, depth = 0): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(properties).map(([k, v]) => [k, mockValueFor(k, v, depth)]),
  );
}

function mockObjectTextFor(options: {
  responseFormat?: { type: "text" } | { type: "json"; schema?: unknown };
}): string | undefined {
  const format = options.responseFormat;
  if (format?.type !== "json") return undefined;
  const schema = format.schema as
    | { properties?: Record<string, unknown>; required?: string[] }
    | undefined;
  const properties = schema?.properties;
  if (!properties || !Object.keys(properties).length) return undefined;
  if ("elements" in properties) return undefined; // Output.array handled elsewhere
  return JSON.stringify(mockObjectFrom(properties));
}

function promptToText(options: {
  prompt: unknown;
}): string {
  const parts = (options.prompt as { content?: unknown }[]) ?? [];
  return parts
    .flatMap((m) =>
      Array.isArray(m?.content) ? m.content : [{ type: "text", text: "" }],
    )
    .map((c) => (c as { text?: string }).text ?? "")
    .join(" ");
}

// True when the prompt already carries tool results, i.e. this is a follow-up
// step after tool execution and the model should answer in text.
function hasToolResult(options: { prompt: unknown }): boolean {
  const parts = (options.prompt as { content?: { type?: string }[] }[]) ?? [];
  return parts.some((m) =>
    Array.isArray(m?.content)
      ? m.content.some((c) => c?.type === "tool-result")
      : false,
  );
}

// Structured-output requests (Output.object/array) and requests without tools
// can never accept a tool call: emitting one breaks the JSON contract.
function mockCanCallTools(options: {
  responseFormat?: unknown;
  tools?: unknown;
}): boolean {
  const format = options.responseFormat as { type?: string } | undefined;
  if (format?.type === "json") return false;
  return Array.isArray(options.tools) && options.tools.length > 0;
}

// Scripted tool call for weather/temperature prompts so the full
// tool-call -> execute -> tool-result -> answer loop runs in mock mode.
function mockToolCallFor(
  promptText: string,
): {
  type: "tool-call";
  toolCallId: string;
  toolName: string;
  input: string;
} | undefined {
  const p = promptText.toLowerCase();
  if (p.includes("search") && (p.includes("github") || p.includes("slack") || p.includes("connector"))) {
    return {
      type: "tool-call" as const,
      toolCallId: "mock-conn-1",
      toolName: "searchConnector",
      input: JSON.stringify({
        connectorId: p.includes("slack") ? "slack" : "github",
        query: promptText.replace(/search (github|slack|connector[a-z ]*) for/i, "").trim() || "latest",
      }),
    };
  }
  if (p.includes("make me a") || (p.includes("powerpoint") || p.includes("spreadsheet") || p.includes("word document"))) {
    const pptx = p.includes("powerpoint") || p.includes("slide") || p.includes("deck");
    const xlsx = !pptx && (p.includes("spreadsheet") || p.includes("excel") || p.includes("workbook") || p.includes("make me a"));
    return {
      type: "tool-call" as const,
      toolCallId: "mock-doc-1",
      toolName: "makeDocument",
      input: JSON.stringify(
        pptx
          ? {
              kind: "pptx",
              filename: "Q1_Review.pptx",
              slides: [{ title: "Q1 Review", bullets: ["Revenue up 12 percent", "EMEA strongest region"] }],
            }
          : xlsx
            ? { kind: "xlsx", filename: "report.xlsx", rows: [["Region", "Revenue"], ["EMEA", 120]] }
            : {
                kind: "docx",
                filename: "summary.docx",
                blocks: [{ heading: "Summary", level: 1 }, { text: "Prepared by Quillon." }],
              },
      ),
    };
  }
  if (p.includes("code") || p.includes("run") || p.includes("execute") || p.includes("sum of") || p.includes("fibonacci")) {
    return {
      type: "tool-call" as const,
      toolCallId: "mock-code-1",
      toolName: "runCode",
      input: JSON.stringify({
        language: "python",
        code: 'import statistics\ndata = [2, 4, 9, 1, 8]\nprint("mean:", statistics.mean(data))\nstatistics.mean(data)',
      }),
    };
  }
  if (p.includes("time") || p.includes("clock") || p.includes("date")) {
    return {
      type: "tool-call" as const,
      toolCallId: "mock-time-1",
      toolName: "getTime",
      input: JSON.stringify({ city: "Tokyo" }),
    };
  }
  if (p.includes("fahrenheit") || p.includes("convert") || p.includes("celsius")) {
    return {
      type: "tool-call" as const,
      toolCallId: "mock-convert-1",
      toolName: "convertTemperature",
      input: JSON.stringify({ temperatureF: 75 }),
    };
  }
  if (p.includes("weather")) {
    return {
      type: "tool-call" as const,
      toolCallId: "mock-weather-1",
      toolName: "weather",
      input: JSON.stringify({ location: "San Francisco" }),
    };
  }
  return undefined;
}

async function getMockLanguageModel(): Promise<LanguageModel> {
  if (!languageMock) {
    languageMock = (async () => {
      const { MockLanguageModelV3 } = await import("ai/test");
      const { simulateReadableStream } = await import("ai");
      return new MockLanguageModelV3({
        doGenerate: async (options) => {
          const toolCall =
            hasToolResult(options) || !mockCanCallTools(options)
              ? undefined
              : mockToolCallFor(promptToText(options));
          if (toolCall) {
            return {
              content: [toolCall],
              finishReason: { unified: "tool-calls" as const, raw: "tool_calls" },
              usage: mockUsage(),
              warnings: [],
            };
          }
          const text =
            mockArrayTextFor(options) ?? mockObjectTextFor(options) ?? mockTextFor(promptToText(options));
          return {
            content: [{ type: "text", text }],
            finishReason: { unified: "stop" as const, raw: "stop" },
            usage: mockUsage(),
            warnings: [],
          };
        },
        doStream: async (options) => {
          const toolCall =
            hasToolResult(options) || !mockCanCallTools(options)
              ? undefined
              : mockToolCallFor(promptToText(options));
          if (toolCall) {
            // Stream the tool input in visible deltas so the UI shows the
            // input-streaming state, then the complete tool-call part.
            const input = toolCall.input;
            const half = Math.max(1, Math.floor(input.length / 2));
            return {
              stream: simulateReadableStream({
                initialDelayInMs: 10,
                chunkDelayInMs: 10,
                chunks: [
                  { type: "stream-start", warnings: [] },
                  {
                    type: "tool-input-start",
                    id: toolCall.toolCallId,
                    toolName: toolCall.toolName,
                  },
                  {
                    type: "tool-input-delta",
                    id: toolCall.toolCallId,
                    delta: input.slice(0, half),
                  },
                  {
                    type: "tool-input-delta",
                    id: toolCall.toolCallId,
                    delta: input.slice(half),
                  },
                  {
                    type: "tool-input-end",
                    id: toolCall.toolCallId,
                  },
                  { ...toolCall, type: "tool-call" },
                  {
                    type: "finish",
                    finishReason: {
                      unified: "tool-calls" as const,
                      raw: "tool_calls",
                    },
                    usage: mockUsage(),
                  },
                ],
              }),
            };
          }
          const text =
            mockArrayTextFor(options) ?? mockObjectTextFor(options) ?? mockTextFor(promptToText(options));
          return {
            stream: simulateReadableStream({
              initialDelayInMs: 10,
              chunkDelayInMs: 10,
              chunks: [
                { type: "stream-start", warnings: [] },
                { type: "text-start", id: "t1" },
                { type: "text-delta", id: "t1", delta: text },
                { type: "text-end", id: "t1" },
                {
                  type: "finish",
                  finishReason: { unified: "stop" as const, raw: "stop" },
                  usage: mockUsage(),
                },
              ],
            }),
          };
        },
      }) as unknown as LanguageModel;
    })();
  }
  return languageMock;
}

async function getMockEmbeddingModel(): Promise<EmbeddingModel> {
  if (!embeddingMock) {
    embeddingMock = (async () => {
      const { MockEmbeddingModelV3 } = await import("ai/test");
      return new MockEmbeddingModelV3({
        maxEmbeddingsPerCall: 8,
        doEmbed: async ({ values }) => ({
          embeddings: values.map((v) =>
            Array.from({ length: 16 }, (_, i) => ((v.length + i) % 7) / 7),
          ),
          usage: { tokens: values.map((v) => v.length).reduce((a, b) => a + b, 0) },
          warnings: [],
        }),
      }) as unknown as EmbeddingModel;
    })();
  }
  return embeddingMock;
}

export function isMockMode(): boolean {
  // Explicit mock switch, or automatic fallback when no Gateway key exists so
  // the app runs zero-config. Set AI_GATEWAY_API_KEY to go live.
  if (process.env.AI_MOCK === "1") return true;
  if (process.env.AI_GATEWAY_API_KEY) return false;
  return !Object.keys(providers).some((id) => providerAvailable(id));
}

export async function resolveModel(
  modelId?: string | null,
): Promise<LanguageModel> {
  const id = (modelId ?? "").trim() || DEFAULT_MODEL;
  if (isMockMode()) return getMockLanguageModel();
  return id as unknown as LanguageModel;
}

export async function resolveEmbeddingModel(
  modelId?: string | null,
): Promise<EmbeddingModel> {
  const id = (modelId ?? "").trim() || DEFAULT_EMBEDDING_MODEL;
  if (isMockMode()) return getMockEmbeddingModel();
  return id as unknown as EmbeddingModel;
}

export function listModels(): { id: ModelId; label: string }[] {
  return [
    { id: "openai/gpt-6-astra", label: "GPT 6 Astra" },
    { id: "anthropic/claude-sonnet-5.5", label: "Claude Sonnet 5.5" },
    { id: "google/gemini-3-pro", label: "Gemini 3 Pro" },
    { id: "openai/gpt-6.1", label: "GPT 6.1" },
    { id: "ollama/llama3.1", label: "Ollama · llama3.1 (local)" },
    { id: "ollama/qwen2.5", label: "Ollama · qwen2.5 (local)" },
    { id: "local/local-model", label: "Local endpoint (LM Studio / vLLM)" },
  ];
}

// ---------------------------------------------------------------------------
// Native provider support.
//
// Each flagship API gets its own official AI SDK provider package, keyed by
// its env var. `<provider>/<model>` routes to that provider natively; ids
// without a known provider prefix stay on the AI Gateway. OpenRouter and any
// other OpenAI-compatible API work through openai-compatible with a custom
// base URL (OPENROUTER_BASE_URL style env vars).
// ---------------------------------------------------------------------------

type ProviderSpec = {
  label: string;
  envVar: string;
  /** Alternative env vars that also enable the provider. */
  altEnvVars?: string[];
  create: (modelId: string) => Promise<LanguageModel>;
};

const providers: Record<string, ProviderSpec> = {
  openai: {
    label: "OpenAI",
    envVar: "OPENAI_API_KEY",
    create: async (m) => {
      const { createOpenAI } = await import("@ai-sdk/openai");
      const openai = createOpenAI({ apiKey: process.env.OPENAI_API_KEY });
      return openai(m || "gpt-4o") as unknown as LanguageModel;
    },
  },
  anthropic: {
    label: "Anthropic",
    envVar: "ANTHROPIC_API_KEY",
    create: async (m) => {
      const { createAnthropic } = await import("@ai-sdk/anthropic");
      const anthropic = createAnthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
      return anthropic(m || "claude-sonnet-4-5") as unknown as LanguageModel;
    },
  },
  google: {
    label: "Google Gemini",
    envVar: "GOOGLE_GENERATIVE_AI_API_KEY",
    altEnvVars: ["GEMINI_API_KEY"],
    create: async (m) => {
      const { createGoogleGenerativeAI } = await import("@ai-sdk/google");
      const google = createGoogleGenerativeAI({
        apiKey: process.env.GOOGLE_GENERATIVE_AI_API_KEY ?? process.env.GEMINI_API_KEY,
      });
      return google(m || "gemini-2.5-pro") as unknown as LanguageModel;
    },
  },
  xai: {
    label: "xAI Grok",
    envVar: "XAI_API_KEY",
    create: async (m) => {
      const { createXai } = await import("@ai-sdk/xai");
      const xai = createXai({ apiKey: process.env.XAI_API_KEY });
      return xai(m || "grok-4") as unknown as LanguageModel;
    },
  },
  mistral: {
    label: "Mistral",
    envVar: "MISTRAL_API_KEY",
    create: async (m) => {
      const { createMistral } = await import("@ai-sdk/mistral");
      const mistral = createMistral({ apiKey: process.env.MISTRAL_API_KEY });
      return mistral(m || "mistral-large-latest") as unknown as LanguageModel;
    },
  },
  groq: {
    label: "Groq",
    envVar: "GROQ_API_KEY",
    create: async (m) => {
      const { createGroq } = await import("@ai-sdk/groq");
      const groq = createGroq({ apiKey: process.env.GROQ_API_KEY });
      return groq(m || "llama-3.3-70b-versatile") as unknown as LanguageModel;
    },
  },
  deepseek: {
    label: "DeepSeek",
    envVar: "DEEPSEEK_API_KEY",
    create: async (m) => {
      const { createDeepSeek } = await import("@ai-sdk/deepseek");
      const deepseek = createDeepSeek({ apiKey: process.env.DEEPSEEK_API_KEY });
      return deepseek(m || "deepseek-chat") as unknown as LanguageModel;
    },
  },
  perplexity: {
    label: "Perplexity",
    envVar: "PERPLEXITY_API_KEY",
    create: async (m) => {
      const { createPerplexity } = await import("@ai-sdk/perplexity");
      const perplexity = createPerplexity({ apiKey: process.env.PERPLEXITY_API_KEY });
      return perplexity(m || "sonar-pro") as unknown as LanguageModel;
    },
  },
  azure: {
    label: "Azure OpenAI",
    envVar: "AZURE_API_KEY",
    altEnvVars: ["AZURE_OPENAI_API_KEY"],
    create: async (m) => {
      const { createAzure } = await import("@ai-sdk/azure");
      const azure = createAzure({ apiKey: process.env.AZURE_API_KEY ?? process.env.AZURE_OPENAI_API_KEY });
      return azure(m || process.env.AZURE_DEPLOYMENT || "gpt-4o") as unknown as LanguageModel;
    },
  },
  bedrock: {
    label: "Amazon Bedrock",
    envVar: "AWS_ACCESS_KEY_ID",
    altEnvVars: ["AWS_SECRET_ACCESS_KEY", "AWS_BEARER_TOKEN_BEDROCK"],
    create: async (m) => {
      const { createAmazonBedrock } = await import("@ai-sdk/amazon-bedrock");
      const bedrock = createAmazonBedrock();
      return bedrock(m || "anthropic.claude-sonnet-4-5-20250929-v1:0") as unknown as LanguageModel;
    },
  },
  openrouter: {
    label: "OpenRouter",
    envVar: "OPENROUTER_API_KEY",
    create: async (m) => {
      const { createOpenAICompatible } = await import("@ai-sdk/openai-compatible");
      const openrouter = createOpenAICompatible({
        name: "openrouter",
        baseURL: process.env.OPENROUTER_BASE_URL ?? "https://openrouter.ai/api/v1",
        apiKey: process.env.OPENROUTER_API_KEY ?? "",
      });
      return openrouter(m || process.env.OPENROUTER_MODEL || "openai/gpt-4o") as unknown as LanguageModel;
    },
  },
  ollama: {
    label: "Ollama (local)",
    envVar: "OLLAMA_BASE_URL",
    create: async (m) => {
      const { createOpenAICompatible } = await import("@ai-sdk/openai-compatible");
      const ollama = createOpenAICompatible({
        name: "ollama",
        baseURL: `${(process.env.OLLAMA_BASE_URL ?? "http://127.0.0.1:11434").replace(/\/$/, "")}/v1`,
        apiKey: process.env.OLLAMA_API_KEY ?? "ollama",
      });
      return ollama(m || process.env.OLLAMA_MODEL || "llama3.1") as unknown as LanguageModel;
    },
  },
  local: {
    label: "Local OpenAI-compatible (LM Studio, vLLM, llama.cpp)",
    envVar: "LOCAL_LLM_BASE_URL",
    create: async (m) => {
      const { createOpenAICompatible } = await import("@ai-sdk/openai-compatible");
      const local = createOpenAICompatible({
        name: "local",
        baseURL: (process.env.LOCAL_LLM_BASE_URL ?? "http://127.0.0.1:1234").replace(/\/$/, "") + "/v1",
        apiKey: process.env.LOCAL_LLM_API_KEY ?? "local",
      });
      return local(m || process.env.LOCAL_LLM_MODEL || "local-model") as unknown as LanguageModel;
    },
  },
};

export type ProviderStatus = {
  id: string;
  label: string;
  envVar: string;
  available: boolean;
};

export function listProviders(): ProviderStatus[] {
  return Object.entries(providers).map(([id, spec]) => ({
    id,
    label: spec.label,
    envVar: spec.envVar,
    available:
      Boolean(process.env[spec.envVar]) ||
      (spec.altEnvVars ?? []).some((v) => Boolean(process.env[v])),
  }));
}

function providerAvailable(id: string): boolean {
  const spec = providers[id];
  if (!spec) return false;
  return (
    Boolean(process.env[spec.envVar]) ||
    (spec.altEnvVars ?? []).some((v) => Boolean(process.env[v]))
  );
}

export const DEFAULT_NATIVE_MODEL =
  process.env.AI_DEFAULT_NATIVE_MODEL ?? "openai/gpt-4o";

/**
 * Resolve a model id to a concrete model:
 *  1. mock mode -> scripted mock model
 *  2. "<provider>/<model>" with a configured provider -> that native SDK
 *     (openrouter/<anything> goes through the OpenRouter OpenAI-compatible API)
 *  3. anything else -> AI Gateway id (e.g. "openai/gpt-6-astra")
 */
export async function resolveModelAny(modelId?: string | null): Promise<LanguageModel> {
  const id = (modelId ?? "").trim() || DEFAULT_MODEL;
  if (isMockMode()) return getMockLanguageModel();

  const slash = id.indexOf("/");
  if (slash > 0) {
    const prefix = id.slice(0, slash);
    const rest = id.slice(slash + 1);
    if (prefix === "openrouter" && providerAvailable("openrouter")) {
      return providers.openrouter.create(rest);
    }
    if (providers[prefix] && providerAvailable(prefix)) {
      return providers[prefix].create(rest);
    }
  }
  return id as unknown as LanguageModel;
}
