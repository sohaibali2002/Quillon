async function secure(req: Request) {
  const gate = await guard(req);
  if (gate instanceof Response) return gate;
  return gate;
}

import { z } from "zod";
import { addMemory, deleteMemory, listMemories, resolveConversation } from "@/lib/memory";

import { guard } from "@/lib/guard";
import { principalForSession } from "@/lib/rbac";
const scopeSchema = z.enum(["conversation", "agent"]);

function badRequest(message: string, issues?: { path: string; message: string }[]) {
  return Response.json({ error: { message, ...(issues ? { issues } : {}) } }, { status: 400 });
}

export async function GET(req: Request) {
  const session = await secure(req);
  if (session instanceof Response) return session;

  const who = principalForSession(session);
  const url = new URL(req.url);
  const requested = url.searchParams.get("conversationId");
  const scopeParam = url.searchParams.get("scope");
  const scope = scopeParam ? scopeSchema.safeParse(scopeParam) : null;
  if (scope && !scope.success) return badRequest("scope must be conversation or agent.");
  const conversationId = requested ? resolveConversation(who, requested) : undefined;
  return Response.json({ memories: listMemories(who, { conversationId, scope: scope?.data }) });
}

const createSchema = z
  .object({
    content: z.string().trim().min(1).max(2000),
    conversationId: z.string().trim().min(1).max(200).default("default"),
    scope: scopeSchema.default("conversation"),
  })
  .strict();

export async function POST(req: Request) {
  const session = await secure(req);
  if (session instanceof Response) return session;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return badRequest("Request body must be valid JSON.");
  }
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) {
    return badRequest(
      "Invalid request body.",
      parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    );
  }
  const who = principalForSession(session);
  const { content, conversationId, scope } = parsed.data;
  const target = resolveConversation(who, conversationId);
  return Response.json({ memory: addMemory(who, content, target, scope), conversationId: target }, { status: 201 });
}

export async function DELETE(req: Request) {
  const session = await secure(req);
  if (session instanceof Response) return session;

  const id = new URL(req.url).searchParams.get("id");
  if (!id) return badRequest("id query parameter is required.");
  const who = principalForSession(session);
  if (!deleteMemory(who, id)) {
    return Response.json({ error: { message: "Memory not found." } }, { status: 404 });
  }
  return new Response(null, { status: 204 });
}
