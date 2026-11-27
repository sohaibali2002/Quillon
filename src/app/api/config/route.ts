async function secure(req: Request) {
  const gate = await guard(req);
  if (gate instanceof Response) return gate;
  return gate;
}

// Model + provider configuration endpoint (read-only).
import { getDefaultModel, getModelCatalog, listProviders } from "@/lib/models";

import { guard, authEnforced } from "@/lib/guard";
export async function GET(req: Request) {
  if (authEnforced()) {
    const gate = await guard(req);
    if (gate instanceof Response) return gate;
  }

  const catalog = await getModelCatalog();
  return Response.json(
    {
      defaultModel: getDefaultModel(catalog.models),
      models: catalog.models,
      modelErrors: catalog.errors,
      providers: listProviders(),
    },
    { headers: { "Cache-Control": "private, no-store, max-age=0" } },
  );
}
