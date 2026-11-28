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
import { resolveAttachmentsForModel } from "@/lib/attachments";
import { compactIfNeeded, compactionContext } from "@/lib/compaction";
import { memoryContext } from "@/lib/memory";
import { listProviders, resolveModelAny } from "@/lib/models";
import { skillsContext } from "@/lib/skills";
import { unifiedToolset } from "@/lib/tool-registry";
import { enforceToolAuthority } from "@/lib/tool-authority";
import { roleOf } from "@/lib/rbac";
import { createOrchestrateTool } from "@/lib/orchestrator";
import { enforceCapabilities, selectRelevantTools, withRecordPolicy, withToolTimeouts } from "@/lib/tool-policy";

import { guard, capabilitySubject } from "@/lib/guard";
export const maxDuration = 30;

// Parts are validated by shape: known types pass through, anything else is
// rejected. File parts must reference an uploaded id or a small inline data URL
// (limits enforced by lib/attachments).
const partSchema = z.union([
  z.object({ type: z.literal("text"), text: z.string() }),
  z.object({
    type: z.literal("file"),
    mediaType: z.string().min(1).max(120),
    filename: z.string().max(300).optional(),
    url: z.string().min(1).max(64 * 1024 * 1024),
  }),
  z.object({ type: z.literal("reasoning"), text: z.string() }),
  z.object({ type: z.literal("source-url"), sourceId: z.string(), url: z.string() }),
  z.object({ type: z.literal("step-start") }),
  // Tool and data parts carry many shapes; their type prefix is the contract.
  z.object({ type: z.string().startsWith("data-") }).passthrough(),
  z.object({ type: z.string().startsWith("tool-") }).passthrough(),
]);

const bodySchema = z.object({
  messages: z
    .array(
      z.object({
        id: z.string().min(1),
        role: z.enum(["system", "user", "assistant"]),
        parts: z.array(partSchema).max(200),
      }),
    )
    .min(1),
  model: z.string().optional(),
  conversationId: z.string().trim().min(1).max(200).default("default"),
  skills: z.array(z.string().min(1).max(80)).max(20).optional(),
  // Per-request step budget; the route default stays 8, callers can raise or
  // lower it while the loop stops on its own when the model is done.
  maxSteps: z.number().int().min(1).max(24).optional(),
});

const DEFAULT_MAX_STEPS = 8;

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

  const { messages, model, conversationId, skills, maxSteps } = parsed.data;

  // Attachments: validate every file part and give the model real bytes only
  // for this turn's files; older turns become text placeholders.
  let resolved: { messages: UIMessage[] };
  try {
    resolved = await resolveAttachmentsForModel(messages as UIMessage[]);
  } catch (error) {
    return Response.json(
      { error: { message: error instanceof Error ? error.message : "Invalid attachment." } },
      { status: 400 },
    );
  }

  // Auto compaction: if the thread outgrew the budget, older turns are folded
  // into a persisted summary and only recent turns are sent verbatim.
  const { result: compaction, keptMessages } = await compactIfNeeded(
    conversationId,
    resolved.messages,
    model,
  );

  // One registry for every tool surface; a dead MCP server becomes an error
  // entry, never a failed chat turn.
  const unified = await unifiedToolset(conversationId);
  if (unified.mcpErrors.length > 0) {
    console.error("mcp toolset errors:", JSON.stringify(unified.mcpErrors));
  }

  const system = [
    "You are a helpful assistant.",
    compactionContext(compaction),
    memoryContext(conversationId),
    await skillsContext(skills ?? []),
  ]
    .filter(Boolean)
    .join("\n\n");

  const lastUserText =
    [...keptMessages]
      .reverse()
      .find((m) => m.role === "user")
      ?.parts.map((p) => (p.type === "text" ? p.text : p.type === "file" ? p.filename ?? "" : ""))
      .join(" ") ?? "";

  // Policy: manifest authority, capability grants bound to the signed-in
  // identity, record restrictions, relevance shortlist, one timeout per call.
  const role = roleOf(denied);
  const toolset = enforceToolAuthority(
    {
      ...unified.tools,
      // Cross-platform pipelines: the model can delegate a whole multi-tool
      // job (fetch → enrich → document) to the orchestrator in one call.
      orchestrate: createOrchestrateTool(model),
    },
    role,
  );
  const granted = enforceCapabilities(toolset, unified.catalog, {
    subject: capabilitySubject(denied),
    role,
  });
  const tools = withToolTimeouts(
    selectRelevantTools(
      withRecordPolicy(granted, unified.catalog, role),
      unified.catalog,
      lastUserText,
    ),
  );

  const result = streamText({
    model: await resolveModelAny(model),
    system,
    tools,
    messages: await convertToModelMessages(keptMessages),
    // Multi-step loop: tool results are fed back so the model can answer.
    stopWhen: stepCountIs(maxSteps ?? DEFAULT_MAX_STEPS),
    abortSignal: req.signal,
    onError({ error }: { error: unknown }) {
      console.error("chat stream error:", error);
    },
  });

  const startedAt = Date.now();
  const metadataErrors = unified.mcpErrors.length > 0 ? unified.mcpErrors : undefined;
  return createUIMessageStreamResponse({
    stream: result.toUIMessageStream({
      // Provider-native citations (web search, grounding) stream as source parts.
      sendSources: true,
      messageMetadata: ({ part }): AnswerMetadata | undefined => {
        if (part.type === "start") return { model: model ?? null, startedAt, mcpErrors: metadataErrors };
        if (part.type === "finish") {
          return {
            model: model ?? null,
            startedAt,
            ms: Date.now() - startedAt,
            inputTokens: part.totalUsage.inputTokens ?? null,
            outputTokens: part.totalUsage.outputTokens ?? null,
            finishReason: part.finishReason,
            compacted: compaction?.compactedCount ?? 0,
            mcpErrors: metadataErrors,
          };
        }
        return undefined;
      },
    }),
  });
}
