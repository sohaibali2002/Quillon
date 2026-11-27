async function secure(req: Request) {
  const gate = await guard(req);
  if (gate instanceof Response) return gate;
  return gate;
}

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
import { ModelConfigurationError, resolveModelAny } from "@/lib/models";
import { skillsContext } from "@/lib/skills";
import { platformTools } from "@/lib/tools";
import { ENTERPRISE_RECIPES } from "@/lib/enterprise-platforms";
import { buildConnectedTools } from "@/lib/connector-sdk";

import { guard } from "@/lib/guard";
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
  const denied = await secure(req);
  if (denied instanceof Response) return denied;

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
  const modelId = model?.trim() || undefined;
  let resolvedModel: Awaited<ReturnType<typeof resolveModelAny>>;
  try {
    resolvedModel = await resolveModelAny(modelId);
  } catch (error) {
    if (error instanceof ModelConfigurationError) {
      return Response.json({ error: { message: error.message } }, { status: error.statusCode });
    }
    throw error;
  }

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
    "You are Quillon, a precise and thoughtful assistant. Read the full request and address every part. Ground claims in the conversation, attached files, tool results, and returned sources; never invent facts, citations, calculations, or tool outcomes. State assumptions and uncertainty when they matter. Keep simple answers brief; make complex answers complete and actionable without filler. Use short descriptive headings when useful, numbered steps for procedures, bullets for parallel points, and fenced code blocks for code. For current or external facts, use available tools and cite the sources they return. Explain important caveats instead of dumping raw tool output.",
    compactionContext(compaction),
    memoryContext(conversationId),
    await skillsContext(skills ?? []),
  ]
    .filter(Boolean)
    .join("\n\n");

  const result = streamText({
    model: resolvedModel,
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
        if (part.type === "start") return { model: modelId ?? null, startedAt };
        if (part.type === "finish") {
          return {
            model: modelId ?? null,
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
