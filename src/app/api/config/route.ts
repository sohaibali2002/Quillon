// Model + provider configuration endpoint (read-only).
import { DEFAULT_MODEL, listModels, listProviders } from "@/lib/models";

export function GET() {
  return Response.json({
    defaultModel: DEFAULT_MODEL,
    models: listModels(),
    gateway: {
      requiredEnvVar: "AI_GATEWAY_API_KEY",
      set: Boolean(process.env.AI_GATEWAY_API_KEY),
    },
    // Native provider integrations: available = env key present.
    providers: listProviders(),
  });
}
