async function secure(req: Request) {
  const gate = await guard(req);
  if (gate instanceof Response) return gate;
  return gate;
}

// Structured output with Output.object / Output.array.
//   { kind: "object" | "array", prompt, model? }
import { Output, generateText, streamText } from "ai";
import { z } from "zod";
import { resolveModelAny as resolveModel } from "@/lib/models";

import { guard } from "@/lib/guard";
export const maxDuration = 30;

const recipeSchema = z.object({
  name: z.string().describe("Name of the dish"),
  ingredients: z.array(z.string()).describe("Ingredients with quantities"),
  steps: z.array(z.string()).describe("Ordered preparation steps"),
  servings: z.number().int().positive(),
});

export async function POST(req: Request) {
  const denied = await secure(req);
  if (denied instanceof Response) return denied;

  const { prompt, kind = "object", stream: asStream = false, model: modelId } =
    await req.json();

  const model = await resolveModel(modelId);
  const output =
    kind === "array"
      ? Output.array({ element: z.object({ step: z.string() }) })
      : Output.object({ schema: recipeSchema });

  if (asStream) {
    const result = streamText({
      model,
      output,
      prompt: String(prompt ?? "A simple pasta recipe"),
      onError({ error }) {
        console.error("structured stream error:", error);
      },
    });
    return result.toTextStreamResponse();
  }

  const promptText = String(prompt ?? "A simple pasta recipe");
  try {
    let result;
    try {
      result = await generateText({ model, output, prompt: promptText });
    } catch (e) {
      // Some providers validate the JSON against the schema server-side and
      // reject a generation that misses a field; one stricter retry fixes it.
      const msg = e instanceof Error ? e.message : "";
      if (!/json_validate_failed|does not match the expected schema/.test(msg)) throw e;
      result = await generateText({
        model,
        output,
        prompt: `${promptText}\n\nReturn every property the schema requires.`,
      });
    }

    return Response.json({
      output: result.output,
      usage: result.usage,
      finishReason: result.finishReason,
    });
  } catch (e) {
    console.error("structured error:", e);
    return Response.json(
      { error: { message: e instanceof Error ? e.message : "Structured generation failed." } },
      { status: 502 },
    );
  }
}
