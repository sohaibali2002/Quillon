import {
  convertToModelMessages,
  createUIMessageStreamResponse,
  stepCountIs,
  streamText,
  type UIMessage,
} from "ai";
import { z } from "zod";
import type { AnswerMetadata } from "@/lib/ai-types";
import { compactIfNeeded, compactionContext } from "@/lib/compaction";
import { createMemoryTools, memoryContext } from "@/lib/memory";
import { mcpToolset } from "@/lib/mcp";
import { listProviders, resolveModelAny } from "@/lib/models";
import { skillsContext } from "@/lib/skills";
import { platformTools } from "@/lib/tools";
import { ENTERPRISE_RECIPES } from "@/lib/enterprise-platforms";
import { buildConnectedTools } from "@/lib/connector-sdk";

export const maxDuration = 30;

const bodySchema = z.object({
  messages: z
    .array(
      z.object({
        id: z.string().min(1),
        role: z.enum(["system", "user", "assistant"]),
        parts: z.array(z.record(z.string(), z.unknown())),
      }),
    )
    .min(1),
  model: z.string().optional(),
  conversationId: z.string().trim().min(1).max(200).default("default"),
  skills: z.array(z.string().min(1).max(80)).max(20).optional(),
});

export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json(
      { error: { message: "Request body must be valid JSON." } },
      { status: 400 },
    );
  }

  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    return Response.json(
      {
        error: {
          message: "Invalid request body.",
          issues: parsed.error.issues.map((i) => ({
            path: i.path.join("."),
            message: i.message,
          })),
        },
      },
      { status: 400 },
    );
  }

  const { messages, model, conversationId, skills } = parsed.data;

  // Auto compaction: if the thread outgrew the budget, older turns are folded
  // into a persisted summary and only recent turns are sent verbatim.
  const { result: compaction, keptMessages } = await compactIfNeeded(
    conversationId,
    messages as UIMessage[],
    model,
  );

  // MCP: live tools from every enabled server; a dead server becomes an
  // error entry, never a failed chat turn.
  const mcp = await mcpToolset();
  if (mcp.errors.length > 0) {
    console.error("mcp toolset errors:", JSON.stringify(mcp.errors));
  }

  const system = [
    "You are a helpful assistant.",
    compactionContext(compaction),
    memoryContext(conversationId),
    await skillsContext(skills ?? []),
  ]
    .filter(Boolean)
    .join("\n\n");

  const result = streamText({
    model: await resolveModelAny(model),
    system,
    tools: { ...platformTools, ...buildConnectedTools(ENTERPRISE_RECIPES), ...createMemoryTools(conversationId), ...mcp.tools },
    messages: await convertToModelMessages(keptMessages),
    // Multi-step loop: tool results are fed back so the model can answer.
    stopWhen: stepCountIs(8),
    abortSignal: req.signal,
    onError({ error }) {
      console.error("chat stream error:", error);
    },
  });

  const startedAt = Date.now();
  return createUIMessageStreamResponse({
    stream: result.toUIMessageStream({
      // Provider-native citations (web search, grounding) stream as source parts.
      sendSources: true,
      messageMetadata: ({ part }): AnswerMetadata | undefined => {
        if (part.type === "start") return { model: model ?? null, startedAt };
        if (part.type === "finish") {
          return {
            model: model ?? null,
            startedAt,
            ms: Date.now() - startedAt,
            inputTokens: part.totalUsage.inputTokens ?? null,
            outputTokens: part.totalUsage.outputTokens ?? null,
            finishReason: part.finishReason,
            compacted: compaction?.compactedCount ?? 0,
          };
        }
        return undefined;
      },
    }),
  });
}
