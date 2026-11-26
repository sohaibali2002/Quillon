async function secure(req: Request) {
  const gate = await guard(req);
  if (gate instanceof Response) return gate;
  return gate;
}

import { z } from "zod";
import { addMemory, deleteMemory, listMemories } from "@/lib/memory";

import { guard } from "@/lib/guard";
const scopeSchema = z.enum(["conversation", "agent"]);

function badRequest(message: string, issues?: { path: string; message: string }[]) {
  return Response.json({ error: { message, ...(issues ? { issues } : {}) } }, { status: 400 });
}

export async function GET(req: Request) {
  const denied = await secure(req);
  if (denied instanceof Response) return denied;

  const url = new URL(req.url);
  const conversationId = url.searchParams.get("conversationId") ?? undefined;
  const scopeParam = url.searchParams.get("scope");
  const scope = scopeParam ? scopeSchema.safeParse(scopeParam) : null;
  if (scope && !scope.success) return badRequest("scope must be conversation or agent.");
  return Response.json({ memories: listMemories(conversationId, scope?.data) });
}

const createSchema = z
  .object({
    content: z.string().trim().min(1).max(2000),
    conversationId: z.string().trim().min(1).max(200).default("default"),
    scope: scopeSchema.default("conversation"),
  })
  .strict();

export async function POST(req: Request) {
  const denied = await secure(req);
  if (denied instanceof Response) return denied;

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
  const { content, conversationId, scope } = parsed.data;
  return Response.json({ memory: addMemory(content, conversationId, scope) }, { status: 201 });
}

export async function DELETE(req: Request) {
  const denied = await secure(req);
  if (denied instanceof Response) return denied;

  const id = new URL(req.url).searchParams.get("id");
  if (!id) return badRequest("id query parameter is required.");
  if (!deleteMemory(id)) {
    return Response.json({ error: { message: "Memory not found." } }, { status: 404 });
  }
  return new Response(null, { status: 204 });
}
