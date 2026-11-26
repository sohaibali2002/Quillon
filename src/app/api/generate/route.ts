async function secure(req: Request) {
  const gate = await guard(req);
  if (gate instanceof Response) return gate;
  return gate;
}

// Core text + tool-calling: non-streaming and streaming.
import {
  convertToModelMessages,
  createUIMessageStreamResponse,
  generateText,
  streamText,
  type UIMessage,
} from "ai";
import { resolveModelAny as resolveModel } from "@/lib/models";
import { platformTools } from "@/lib/tools";

import { guard } from "@/lib/guard";
export const maxDuration = 30;

// POST /api/generate
//   { prompt, model? }                  -> { text, usage, finishReason, steps }
//   { messages: UIMessage[], model? }   -> same
export async function POST(req: Request) {
  const denied = await secure(req);
  if (denied instanceof Response) return denied;

  const body = await req.json();
  const model = await resolveModel(body.model);

  const messages = body.messages
    ? await convertToModelMessages(body.messages as UIMessage[])
    : [{ role: "user" as const, content: String(body.prompt ?? "") }];

  if (body.stream) {
    const result = streamText({
      model,
      tools: platformTools,
      messages,
      onError({ error }) {
        console.error("generate stream error:", error);
      },
    });
    return createUIMessageStreamResponse({
      stream: result.toUIMessageStream(),
    });
  }

  const result = await generateText({
    model,
    tools: platformTools,
    messages,
  });

  return Response.json({
    text: result.text,
    toolCalls: result.toolCalls,
    toolResults: result.toolResults,
    steps: result.steps.length,
    usage: result.usage,
    finishReason: result.finishReason,
  });
}
