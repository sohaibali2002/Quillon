async function secure(req: Request) {
  const gate = await guard(req);
  if (gate instanceof Response) return gate;
  return gate;
}

// Model + provider configuration endpoint (read-only).
import { DEFAULT_MODEL, listModels, listProviders } from "@/lib/models";

import { guard, authEnforced } from "@/lib/guard";
export async function GET(req: Request) {
  // Read-only model catalog, but in locked-down mode it still needs a session.
  if (authEnforced()) {
    const gate = await guard(req);
    if (gate instanceof Response) return gate;
  }
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
