async function secure(req: Request) {
  const gate = await guard(req);
  if (gate instanceof Response) return gate;
  return gate;
}

// Embeddings + similarity. AI Gateway embedding model id by default.
//   { input: string | string[], model?, compare?: [string, string] }
import { embed, embedMany, cosineSimilarity } from "ai";
import { resolveEmbeddingModel } from "@/lib/models";

import { guard } from "@/lib/guard";
export const maxDuration = 30;

export async function POST(req: Request) {
  const denied = await secure(req);
  if (denied instanceof Response) return denied;

  const {
    input,
    compare,
    model,
  }: {
    input?: string | string[];
    compare?: [string, string];
    model?: string;
  } = await req.json();

  const embeddingModel = await resolveEmbeddingModel(model);

  if (compare) {
    const [a, b] = compare;
    const ea = await embed({ model: embeddingModel, value: a });
    const eb = await embed({ model: embeddingModel, value: b });
    return Response.json({
      similarity: cosineSimilarity(ea.embedding, eb.embedding),
      dimensions: ea.embedding.length,
    });
  }

  if (Array.isArray(input)) {
    const { embeddings, usage } = await embedMany({
      model: embeddingModel,
      values: input,
    });
    return Response.json({ embeddings, usage, count: embeddings.length });
  }

  const { embedding, usage } = await embed({
    model: embeddingModel,
    value: String(input ?? ""),
  });
  return Response.json({ embedding, usage, dimensions: embedding.length });
}
