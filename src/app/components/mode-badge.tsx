type ProviderStatus = {
  id: string;
  label: string;
  available: boolean;
  freeTier: boolean;
};

type ModelOption = { provider: string; providerLabel: string; id: string };

type Props = {
  models: ModelOption[];
  providers: ProviderStatus[];
  loading: boolean;
  error?: Error;
  modelErrors: string[];
};

export default function ModeBadge({ models, providers, loading, error, modelErrors }: Props) {
  const connected = providers.filter((provider) => provider.available);
  const availableProviders = new Set(models.map((model) => model.provider));
  const active = connected.filter((provider) => availableProviders.has(provider.id));
  const status = loading ? "loading" : models.length > 0 ? "ready" : connected.length > 0 || error || modelErrors.length > 0 ? "warning" : "offline";
  const label = loading
    ? "Checking models"
    : models.length > 0
      ? `${models.length} ${models.length === 1 ? "model" : "models"} available`
      : connected.length > 0
        ? "No models found"
        : "Provider needed";
  const detail = active.length > 0
    ? `Available from ${active.map((provider) => provider.label).join(", ")}`
    : modelErrors.length > 0
      ? modelErrors.join(" ")
      : error?.message ?? "Connect a provider to load models.";

  return (
    <span className="chat-model-status" data-state={status} role="status" title={detail}>
      <span aria-hidden="true" />
      {label}
    </span>
  );
}
