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
import { createMemoryTools, memoryContext } from "@/lib/memory";
import { mcpToolset } from "@/lib/mcp";
import { resolveModelAny as resolveModel } from "@/lib/models";
import { skillsContext } from "@/lib/skills";
import { platformTools } from "@/lib/tools";
import { ENTERPRISE_RECIPES } from "@/lib/enterprise-platforms";
import { buildConnectedTools } from "@/lib/connector-sdk";

import { guard } from "@/lib/guard";
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
      .trim() || "What is the weather in San Francisco?"
  );
}

export async function POST(req: Request) {
  const denied = await secure(req);
  if (denied instanceof Response) return denied;

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
  const conversationId = body.conversationId ?? "agent";

  const mcp = await mcpToolset();
  if (mcp.errors.length > 0) {
    console.error("mcp toolset errors:", JSON.stringify(mcp.errors));
  }

  const agent = new ToolLoopAgent({
    model: await resolveModel(body.model),
    instructions: [
      "Answer using the available tools when they help.",
      memoryContext(conversationId),
      await skillsContext(body.skills ?? []),
    ]
      .filter(Boolean)
      .join("\n\n"),
    tools: { ...platformTools, ...buildConnectedTools(ENTERPRISE_RECIPES), ...createMemoryTools(conversationId), ...mcp.tools },
    stopWhen: stepCountIs(8),
    output:
      mode === "structured"
        ? Output.object({ schema: summarySchema })
        : undefined,
  });

  if (mode === "structured") {
    const result = await agent.generate({ prompt });
    return Response.json({
      output: result.output,
      steps: result.steps.length,
      usage: result.usage,
    });
  }

  // Text mode: stream tool calls and text as UI message stream parts.
  const stream = await agent.stream({ prompt, abortSignal: req.signal });
  return createUIMessageStreamResponse({ stream: stream.toUIMessageStream() });
}
