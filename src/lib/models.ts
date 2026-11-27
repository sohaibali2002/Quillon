import type { EmbeddingModel, LanguageModel } from "ai";

export const DEFAULT_EMBEDDING_MODEL =
  process.env.AI_EMBEDDING_MODEL ?? "openai/text-embedding-3-small";

export type ModelId = string;
export type ModelOption = {
  id: ModelId;
  label: string;
  provider: string;
  providerLabel: string;
  freeTier: boolean;
};

export type ProviderStatus = {
  id: string;
  label: string;
  envVar: string;
  available: boolean;
  freeTier: boolean;
};

export type ModelCatalog = {
  models: ModelOption[];
  errors: string[];
};

export class ModelConfigurationError extends Error {
  readonly statusCode = 503;

  constructor(message: string) {
    super(message);
    this.name = "ModelConfigurationError";
  }
}

type ProviderSpec = {
  label: string;
  envVar: string;
  freeTier?: boolean;
  altEnvVars?: string[];
  create: (modelId: string) => Promise<LanguageModel>;
};

const providers: Record<string, ProviderSpec> = {
  openai: {
    label: "OpenAI",
    envVar: "OPENAI_API_KEY",
    create: async (modelId) => {
      const { createOpenAI } = await import("@ai-sdk/openai");
      return createOpenAI({ apiKey: process.env.OPENAI_API_KEY })(modelId || "gpt-4o") as unknown as LanguageModel;
    },
  },
  anthropic: {
    label: "Anthropic",
    envVar: "ANTHROPIC_API_KEY",
    create: async (modelId) => {
      const { createAnthropic } = await import("@ai-sdk/anthropic");
      return createAnthropic({ apiKey: process.env.ANTHROPIC_API_KEY })(modelId || "claude-sonnet-4-5") as unknown as LanguageModel;
    },
  },
  google: {
    label: "Google Gemini",
    envVar: "GOOGLE_GENERATIVE_AI_API_KEY",
    altEnvVars: ["GEMINI_API_KEY"],
    create: async (modelId) => {
      const { createGoogleGenerativeAI } = await import("@ai-sdk/google");
      const google = createGoogleGenerativeAI({
        apiKey: process.env.GOOGLE_GENERATIVE_AI_API_KEY ?? process.env.GEMINI_API_KEY,
      });
      return google(modelId || "gemini-2.5-pro") as unknown as LanguageModel;
    },
  },
  xai: {
    label: "xAI Grok",
    envVar: "XAI_API_KEY",
    create: async (modelId) => {
      const { createXai } = await import("@ai-sdk/xai");
      return createXai({ apiKey: process.env.XAI_API_KEY })(modelId || "grok-4") as unknown as LanguageModel;
    },
  },
  mistral: {
    label: "Mistral",
    envVar: "MISTRAL_API_KEY",
    create: async (modelId) => {
      const { createMistral } = await import("@ai-sdk/mistral");
      return createMistral({ apiKey: process.env.MISTRAL_API_KEY })(modelId || "mistral-large-latest") as unknown as LanguageModel;
    },
  },
  cerebras: {
    label: "Cerebras",
    envVar: "CEREBRAS_API_KEY",
    freeTier: true,
    create: async (modelId) => {
      const { createOpenAICompatible } = await import("@ai-sdk/openai-compatible");
      const cerebras = createOpenAICompatible({
        name: "cerebras",
        baseURL: "https://api.cerebras.ai/v1",
        apiKey: process.env.CEREBRAS_API_KEY ?? "",
      });
      return cerebras(modelId || "gpt-oss-120b") as unknown as LanguageModel;
    },
  },
  groq: {
    label: "Groq",
    envVar: "GROQ_API_KEY",
    freeTier: true,
    create: async (modelId) => {
      const { createGroq } = await import("@ai-sdk/groq");
      return createGroq({ apiKey: process.env.GROQ_API_KEY })(modelId || "llama-3.3-70b-versatile") as unknown as LanguageModel;
    },
  },
  deepseek: {
    label: "DeepSeek",
    envVar: "DEEPSEEK_API_KEY",
    create: async (modelId) => {
      const { createDeepSeek } = await import("@ai-sdk/deepseek");
      return createDeepSeek({ apiKey: process.env.DEEPSEEK_API_KEY })(modelId || "deepseek-chat") as unknown as LanguageModel;
    },
  },
  perplexity: {
    label: "Perplexity",
    envVar: "PERPLEXITY_API_KEY",
    create: async (modelId) => {
      const { createPerplexity } = await import("@ai-sdk/perplexity");
      return createPerplexity({ apiKey: process.env.PERPLEXITY_API_KEY })(modelId || "sonar-pro") as unknown as LanguageModel;
    },
  },
  azure: {
    label: "Azure OpenAI",
    envVar: "AZURE_API_KEY",
    altEnvVars: ["AZURE_OPENAI_API_KEY"],
    create: async (modelId) => {
      const { createAzure } = await import("@ai-sdk/azure");
      const azure = createAzure({
        apiKey: process.env.AZURE_API_KEY ?? process.env.AZURE_OPENAI_API_KEY,
      });
      return azure(modelId || process.env.AZURE_DEPLOYMENT || "gpt-4o") as unknown as LanguageModel;
    },
  },
  bedrock: {
    label: "Amazon Bedrock",
    envVar: "AWS_ACCESS_KEY_ID",
    altEnvVars: ["AWS_SECRET_ACCESS_KEY", "AWS_BEARER_TOKEN_BEDROCK"],
    create: async (modelId) => {
      const { createAmazonBedrock } = await import("@ai-sdk/amazon-bedrock");
      return createAmazonBedrock()(modelId || "anthropic.claude-sonnet-4-5-20250929-v1:0") as unknown as LanguageModel;
    },
  },
  openrouter: {
    label: "OpenRouter",
    envVar: "OPENROUTER_API_KEY",
    freeTier: true,
    create: async (modelId) => {
      const { createOpenAICompatible } = await import("@ai-sdk/openai-compatible");
      const openrouter = createOpenAICompatible({
        name: "openrouter",
        baseURL: process.env.OPENROUTER_BASE_URL ?? "https://openrouter.ai/api/v1",
        apiKey: process.env.OPENROUTER_API_KEY ?? "",
      });
      return openrouter(modelId || "openrouter/free") as unknown as LanguageModel;
    },
  },
  ollama: {
    label: "Ollama (local)",
    envVar: "OLLAMA_BASE_URL",
    create: async (modelId) => {
      const { createOpenAICompatible } = await import("@ai-sdk/openai-compatible");
      const ollama = createOpenAICompatible({
        name: "ollama",
        baseURL: `${(process.env.OLLAMA_BASE_URL ?? "http://127.0.0.1:11434").replace(/\/$/, "")}/v1`,
        apiKey: process.env.OLLAMA_API_KEY ?? "ollama",
      });
      return ollama(modelId || process.env.OLLAMA_MODEL || "llama3.1") as unknown as LanguageModel;
    },
  },
  local: {
    label: "Local OpenAI-compatible",
    envVar: "LOCAL_LLM_BASE_URL",
    create: async (modelId) => {
      const { createOpenAICompatible } = await import("@ai-sdk/openai-compatible");
      const local = createOpenAICompatible({
        name: "local",
        baseURL: `${(process.env.LOCAL_LLM_BASE_URL ?? "http://127.0.0.1:1234").replace(/\/$/, "")}/v1`,
        apiKey: process.env.LOCAL_LLM_API_KEY ?? "local",
      });
      return local(modelId || process.env.LOCAL_LLM_MODEL || "local-model") as unknown as LanguageModel;
    },
  },
};

function providerAvailable(id: string): boolean {
  const spec = providers[id];
  if (!spec) return false;
  return Boolean(process.env[spec.envVar]) || (spec.altEnvVars ?? []).some((name) => Boolean(process.env[name]));
}

export function listProviders(): ProviderStatus[] {
  return Object.entries(providers).map(([id, spec]) => ({
    id,
    label: spec.label,
    envVar: spec.envVar,
    freeTier: Boolean(spec.freeTier),
    available: providerAvailable(id),
  }));
}

function preferredDefaultModel(): string {
  const explicit = process.env.AI_DEFAULT_MODEL?.trim();
  if (explicit) {
    const providerId = explicit.split("/", 1)[0];
    if (providerAvailable(providerId)) return explicit;
  }
  if (providerAvailable("cerebras")) return "cerebras/gpt-oss-120b";
  if (providerAvailable("groq")) return "groq/llama-3.3-70b-versatile";
  if (providerAvailable("openrouter")) return "openrouter/openrouter/free";
  if (providerAvailable("ollama")) return `ollama/${process.env.OLLAMA_MODEL || "llama3.1"}`;
  if (providerAvailable("local")) return `local/${process.env.LOCAL_LLM_MODEL || "local-model"}`;
  return "";
}

export const DEFAULT_MODEL = preferredDefaultModel();

const catalogSources = [
  { id: "cerebras", label: "Cerebras", url: "https://api.cerebras.ai/v1/models" },
  { id: "groq", label: "Groq", url: "https://api.groq.com/openai/v1/models" },
  { id: "openrouter", label: "OpenRouter", url: "https://openrouter.ai/api/v1/models" },
] as const;

const excludedModelId = /embed|whisper|transcri|speech|audio|image-generation|moderation|guard|orpheus|rerank|tts|safeguard/i;
const maxModelsPerProvider = 40;

async function readLocalCatalog(providerId: "ollama" | "local"): Promise<ModelOption[]> {
  if (!providerAvailable(providerId)) return [];

  const baseUrl = providerId === "ollama"
    ? (process.env.OLLAMA_BASE_URL ?? "http://127.0.0.1:11434").replace(/\/$/, "")
    : (process.env.LOCAL_LLM_BASE_URL ?? "http://127.0.0.1:1234").replace(/\/$/, "");
  const url = providerId === "ollama" ? `${baseUrl}/api/tags` : `${baseUrl}/v1/models`;
  const headers = providerId === "local" && process.env.LOCAL_LLM_API_KEY
    ? { Authorization: `Bearer ${process.env.LOCAL_LLM_API_KEY}` }
    : undefined;
  const response = await fetch(url, {
    headers,
    cache: "no-store",
    signal: AbortSignal.timeout(2500),
  });
  if (!response.ok) throw new Error(`${providers[providerId].label} model catalog returned HTTP ${response.status}.`);

  const payload: unknown = await response.json();
  const entries = providerId === "ollama"
    ? (payload as { models?: unknown })?.models
    : (payload as { data?: unknown })?.data;
  if (!Array.isArray(entries)) throw new Error(`${providers[providerId].label} returned an unexpected model catalog.`);

  return entries
    .filter((entry): entry is Record<string, unknown> => typeof entry === "object" && entry !== null)
    .map((entry) => {
      const id = typeof entry.id === "string" ? entry.id : typeof entry.name === "string" ? entry.name : "";
      return { entry, id };
    })
    .filter(({ id }) => Boolean(id) && !excludedModelId.test(id))
    .map(({ entry, id }) => ({
      id: `${providerId}/${id}`,
      label: typeof entry.name === "string" ? entry.name : id,
      provider: providerId,
      providerLabel: providers[providerId].label,
      freeTier: false,
    }));
}

function isFreePrice(value: unknown): boolean {
  return typeof value === "string" || typeof value === "number" ? Number(value) === 0 : false;
}

async function readCatalog(source: (typeof catalogSources)[number]): Promise<ModelOption[]> {
  const key = process.env[providers[source.id].envVar];
  if (!key) return [];

  const response = await fetch(source.url, {
    headers: { Authorization: `Bearer ${key}` },
    cache: "no-store",
    signal: AbortSignal.timeout(4500),
  });
  if (!response.ok) {
    throw new Error(`${source.label} model catalog returned HTTP ${response.status}.`);
  }

  const payload: unknown = await response.json();
  const entries = (payload as { data?: unknown })?.data;
  if (!Array.isArray(entries)) throw new Error(`${source.label} returned an unexpected model catalog.`);

  return entries
    .filter((entry): entry is Record<string, unknown> => typeof entry === "object" && entry !== null)
    .filter((entry) => {
      const id = typeof entry.id === "string" ? entry.id : "";
      if (!id || excludedModelId.test(id)) return false;
      if (source.id !== "openrouter") return true;

      const pricing = entry.pricing as { prompt?: unknown; completion?: unknown } | undefined;
      const modalities = (entry.architecture as { output_modalities?: unknown } | undefined)?.output_modalities;
      const parameters = entry.supported_parameters;
      const supportsTools = !Array.isArray(parameters) || parameters.includes("tools") || parameters.includes("tool_choice");
      const supportsText = !Array.isArray(modalities) || modalities.includes("text");
      return isFreePrice(pricing?.prompt) && isFreePrice(pricing?.completion) && supportsTools && supportsText;
    })
    .slice(0, maxModelsPerProvider)
    .map((entry) => {
      const modelId = String(entry.id);
      const name = typeof entry.name === "string" ? entry.name : modelId;
      return {
        id: `${source.id}/${modelId}`,
        label: name,
        provider: source.id,
        providerLabel: source.label,
        freeTier: true,
      };
    });
}

let cachedCatalog: { expiresAt: number; value: ModelCatalog } | undefined;
let catalogRequest: Promise<ModelCatalog> | undefined;

export async function getModelCatalog(): Promise<ModelCatalog> {
  if (cachedCatalog && cachedCatalog.expiresAt > Date.now()) return cachedCatalog.value;
  if (catalogRequest) return catalogRequest;

  catalogRequest = (async () => {
    const results = await Promise.all(
      catalogSources.map(async (source) => {
        if (!providerAvailable(source.id)) return { source, models: [], error: null as string | null };
        try {
          return { source, models: await readCatalog(source), error: null as string | null };
        } catch (error) {
          const message = error instanceof Error ? error.message : "the request failed";
          return { source, models: [], error: `${message} Check the configured key and try again.` };
        }
      }),
    );
    const localResults = await Promise.all(
      (["ollama", "local"] as const).map(async (providerId) => {
        if (!providerAvailable(providerId)) return { models: [], error: null as string | null };
        try {
          return { models: await readLocalCatalog(providerId), error: null as string | null };
        } catch (error) {
          const message = error instanceof Error ? error.message : "the request failed";
          return { models: [], error: `${message} Check the configured local endpoint.` };
        }
      }),
    );

    const models = [
      ...results.flatMap((result) => result.models),
      ...localResults.flatMap((result) => result.models),
    ];
    const explicit = process.env.AI_DEFAULT_MODEL?.trim();
    if (explicit && providerAvailable(explicit.split("/", 1)[0]) && !models.some((model) => model.id === explicit)) {
      const providerId = explicit.split("/", 1)[0];
      const providerLabel = providers[providerId]?.label;
      if (providerLabel) {
        models.unshift({ id: explicit, label: explicit.slice(providerId.length + 1), provider: providerId, providerLabel, freeTier: Boolean(providers[providerId].freeTier) });
      }
    }

    const value = {
      models,
      errors: [
        ...results.flatMap((result) => result.error ? [result.error] : []),
        ...localResults.flatMap((result) => result.error ? [result.error] : []),
      ],
    };
    cachedCatalog = { expiresAt: Date.now() + (value.errors.length ? 15_000 : 60_000), value };
    return value;
  })();

  try {
    return await catalogRequest;
  } finally {
    catalogRequest = undefined;
  }
}

export async function listModels(): Promise<ModelOption[]> {
  return (await getModelCatalog()).models;
}

export function getDefaultModel(models: ModelOption[]): string {
  const explicit = process.env.AI_DEFAULT_MODEL?.trim();
  if (explicit && models.some((model) => model.id === explicit)) return explicit;
  if (DEFAULT_MODEL && models.some((model) => model.id === DEFAULT_MODEL)) return DEFAULT_MODEL;
  return models[0]?.id ?? "";
}

export async function resolveModel(
  modelId?: string | null,
): Promise<LanguageModel> {
  return resolveModelAny(modelId);
}

export async function resolveModelAny(modelId?: string | null): Promise<LanguageModel> {
  const id = (modelId ?? "").trim() || DEFAULT_MODEL;
  if (!id) {
    throw new ModelConfigurationError(
      "No usable chat model is available. Configure a Cerebras, Groq, or OpenRouter provider key.",
    );
  }

  const slash = id.indexOf("/");
  if (slash < 1) throw new ModelConfigurationError("Choose a model using its provider/model ID.");

  const providerId = id.slice(0, slash);
  const spec = providers[providerId];
  if (!spec) throw new ModelConfigurationError(`The ${providerId} model provider is not supported.`);
  if (!providerAvailable(providerId)) {
    throw new ModelConfigurationError(`Configure ${spec.envVar} to use ${spec.label} models.`);
  }

  return spec.create(id.slice(slash + 1));
}

export async function resolveEmbeddingModel(
  modelId?: string | null,
): Promise<EmbeddingModel> {
  const configured = (modelId ?? "").trim() || DEFAULT_EMBEDDING_MODEL;
  const normalized = configured.includes("/") ? configured : `openai/${configured}`;
  const [providerId, ...modelParts] = normalized.split("/");
  if (providerId !== "openai" || !providerAvailable("openai")) {
    throw new ModelConfigurationError(
      "Embeddings require an OpenAI API key and an OpenAI embedding model.",
    );
  }

  const { createOpenAI } = await import("@ai-sdk/openai");
  return createOpenAI({ apiKey: process.env.OPENAI_API_KEY }).embedding(modelParts.join("/")) as unknown as EmbeddingModel;
}
