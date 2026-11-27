async function secure(req: Request) {
  const gate = await guard(req);
  if (gate instanceof Response) return gate;
  return gate;
}

// Embeddings + similarity use a configured OpenAI embedding model.
//   { input: string | string[], model?, compare?: [string, string] }
import { embed, embedMany, cosineSimilarity } from "ai";
import { ModelConfigurationError, resolveEmbeddingModel } from "@/lib/models";

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

  let embeddingModel: Awaited<ReturnType<typeof resolveEmbeddingModel>>;
  try {
    embeddingModel = await resolveEmbeddingModel(model);
  } catch (error) {
    if (error instanceof ModelConfigurationError) {
      return Response.json({ error: { message: error.message } }, { status: error.statusCode });
    }
    throw error;
  }

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
