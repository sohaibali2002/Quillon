// Provider configuration layer.
//
// Model ids are AI Gateway strings like "openai/gpt-6-astra" and are routed
// through the Vercel AI Gateway, authenticated with AI_GATEWAY_API_KEY.
// Direct provider packages can be added later; the id decides the route.

import type { EmbeddingModel, LanguageModel } from "ai";

export const DEFAULT_MODEL =
  process.env.AI_DEFAULT_MODEL ?? "openai/gpt-6-astra";
export const DEFAULT_EMBEDDING_MODEL =
  process.env.AI_EMBEDDING_MODEL ?? "openai/text-embedding-4";

export type ModelId = string;

export async function resolveModel(
  modelId?: string | null,
): Promise<LanguageModel> {
  const id = (modelId ?? "").trim() || DEFAULT_MODEL;
  return id as unknown as LanguageModel;
}

export async function resolveEmbeddingModel(
  modelId?: string | null,
): Promise<EmbeddingModel> {
  const id = (modelId ?? "").trim() || DEFAULT_EMBEDDING_MODEL;
  // Gateway embedding ids need the Gateway key; with only OPENAI_API_KEY set,
  // fall back to OpenAI embeddings directly.
  if (
    id === DEFAULT_EMBEDDING_MODEL &&
    !process.env.AI_GATEWAY_API_KEY &&
    providerAvailable("openai")
  ) {
    const { createOpenAI } = await import("@ai-sdk/openai");
    return createOpenAI({ apiKey: process.env.OPENAI_API_KEY }).textEmbeddingModel(
      "text-embedding-3-small",
    ) as unknown as EmbeddingModel;
  }
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
      return groq(m || process.env.GROQ_MODEL || "openai/gpt-oss-120b") as unknown as LanguageModel;
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
        // Attribution headers the OpenRouter docs ask every app to send.
        headers: {
          "HTTP-Referer": process.env.APP_URL || "https://github.com/sohaibali2002/Quillon",
          "X-Title": process.env.OPENROUTER_APP_NAME || "Quillon",
        },
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
 *  1. "<provider>/<model>" with a configured provider -> that native SDK
 *     (openrouter/<anything> goes through the OpenRouter OpenAI-compatible API)
 *  2. anything else -> AI Gateway id (e.g. "openai/gpt-6-astra")
 *  3. Gateway id with no AI_GATEWAY_API_KEY but a native provider configured
 *     -> that provider's default model, so one key of any kind is enough.
 */
export async function resolveModelAny(modelId?: string | null): Promise<LanguageModel> {
  const id = (modelId ?? "").trim() || DEFAULT_MODEL;

  const slash = id.indexOf("/");
  if (slash > 0) {
    const prefix = id.slice(0, slash);
    const rest = id.slice(slash + 1);
    if (providers[prefix] && providerAvailable(prefix)) {
      return providers[prefix].create(rest);
    }
  }
  if (!process.env.AI_GATEWAY_API_KEY) {
    const native = Object.keys(providers).find(providerAvailable);
    if (native) return providers[native].create("");
  }
  return id as unknown as LanguageModel;
}
