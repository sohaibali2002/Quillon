async function secure(req: Request) {
  const gate = await guard(req);
  if (gate instanceof Response) return gate;
  return gate;
}

// Agents: ToolLoopAgent with tool loop, step limits, structured subagents.
// Text mode streams a UI message stream (tools appear as streamable parts in
// the client); structured mode returns JSON.
//   Body: { prompt | messages, model?, mode?: "text" | "structured" }
import {
  convertToModelMessages,
  createUIMessageStreamResponse,
  generateText,
  Output,
  stepCountIs,
  ToolLoopAgent,
  type UIMessage,
} from "ai";
import { z } from "zod";
import { memoryContext, resolveConversation } from "@/lib/memory";
import { resolveModelAny as resolveModel } from "@/lib/models";
import { skillsContext } from "@/lib/skills";
import { unifiedToolset } from "@/lib/tool-registry";
import { enforceToolAuthority } from "@/lib/tool-authority";
import { principalForSession, roleOf } from "@/lib/rbac";
import { enforceCapabilities, selectRelevantTools, withRecordPolicy, withToolTimeouts } from "@/lib/tool-policy";
import { createOrchestrateTool } from "@/lib/orchestrator";

import { guard, capabilitySubject } from "@/lib/guard";
import { enforceRateLimit } from "@/lib/rate-limit";
export const maxDuration = 60;

const summarySchema = z.object({
  summary: z.string(),
  toolsUsed: z.array(z.string()),
  confidence: z.number().min(0).max(1),
});

const bodySchema = z.object({
  prompt: z.string().optional(),
  messages: z
    .array(
      z.object({
        role: z.enum(["system", "user", "assistant"]),
        parts: z.array(z.record(z.string(), z.unknown())),
      }),
    )
    .optional(),
  model: z.string().optional(),
  mode: z.enum(["text", "structured"]).optional(),
  conversationId: z.string().trim().min(1).max(200).optional(),
  skills: z.array(z.string().min(1).max(80)).max(20).optional(),
});

function promptFromBody(body: {
  prompt?: string;
  messages?: { role: string; parts: { type?: string; text?: string }[] }[];
}): string {
  if (body.prompt) return body.prompt;
  const lastUser = [...(body.messages ?? [])].reverse().find((m) => m.role === "user");
  return (
    lastUser?.parts
      .filter((p) => p.type === "text")
      .map((p) => p.text ?? "")
      .join(" ")
      .trim() || "Run a Python snippet that prints 6*7 and explain the result."
  );
}

export async function POST(req: Request) {
  const denied = await secure(req);
  if (denied instanceof Response) return denied;
  const limited = enforceRateLimit(capabilitySubject(denied), "agent", 20, 60_000);
  if (limited) return limited;

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return Response.json(
      { error: { message: "Request body must be valid JSON." } },
      { status: 400 },
    );
  }

  const parsed = bodySchema.safeParse(raw);
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
  const { body } = { body: parsed.data };
  const mode = body.mode ?? "text";
  const prompt = promptFromBody(body);
  // The conversation is server-resolved inside the caller's own namespace: a
  // client-supplied id owned by another identity is replaced, never honoured.
  const principal = principalForSession(denied);
  const conversationId = resolveConversation(principal, body.conversationId ?? "agent");

  const unified = await unifiedToolset(conversationId, principal);
  if (unified.mcpErrors.length > 0) {
    console.error("mcp toolset errors:", JSON.stringify(unified.mcpErrors));
  }

  // Policy: manifest authority, capability grants bound to the signed-in
  // identity, record restrictions, relevance shortlist, one timeout per call.
  // Structured mode is a pure summarisation pass: exposing tools there makes
  // models answer with a tool call instead of the JSON object, so it runs bare.
  const role = roleOf(denied);
  const granted = enforceCapabilities(
    enforceToolAuthority(
      {
        ...unified.tools,
        orchestrate: createOrchestrateTool(body.model),
      },
      role,
    ),
    unified.catalog,
    { subject: capabilitySubject(denied), role },
  );
  const toolset = withToolTimeouts(
    selectRelevantTools(
      withRecordPolicy(granted, unified.catalog, role),
      unified.catalog,
      prompt,
    ),
  );

  const agent = new ToolLoopAgent({
    model: await resolveModel(body.model),
    instructions: [
      "Answer using the available tools when they help.",
      memoryContext(principal, conversationId),
      await skillsContext(body.skills ?? []),
    ]
      .filter(Boolean)
      .join("\n\n"),
    tools: mode === "structured" ? undefined : toolset,
    stopWhen: stepCountIs(8),
    output:
      mode === "structured"
        ? Output.object({ schema: summarySchema })
        : undefined,
  });

  if (mode === "structured") {
    try {
      const result = await agent.generate({ prompt });
      return Response.json({
        output: result.output,
        steps: result.steps.length,
        usage: result.usage,
      });
    } catch (e) {
      // Some models answer in text instead of calling the forced output tool
      // ("tool_use_failed"); fall back to a plain structured generation.
      if (!(e instanceof Error) || !e.message.includes("did not call a tool")) throw e;
      const { text } = await generateText({
        model: await resolveModel(body.model),
        prompt,
        output: Output.object({ schema: summarySchema }),
      });
      return Response.json({ output: text, steps: 1, usage: undefined });
    }
  }

  // Text mode: stream tool calls and text as UI message stream parts.
  const stream = await agent.stream({ prompt, abortSignal: req.signal });
  return createUIMessageStreamResponse({ stream: stream.toUIMessageStream() });
}
