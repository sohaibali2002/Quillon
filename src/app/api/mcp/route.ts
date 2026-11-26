async function secure(req: Request) {
  const gate = await guard(req, { role: "admin" });
  if (gate instanceof Response) return gate;
  return gate;
}

import { z } from "zod";
import { guard } from "@/lib/guard";
import {
  addMcpServer,
  callMcpTool,
  deleteMcpServer,
  discoverAllTools,
  listMcpServers,
  setMcpServerEnabled,
} from "@/lib/mcp";

export const maxDuration = 30;

function badRequest(message: string, issues?: { path: string; message: string }[]) {
  return Response.json({ error: { message, ...(issues ? { issues } : {}) } }, { status: 400 });
}

function issues(err: z.ZodError) {
  return err.issues.map((i) => ({ path: i.path.join("."), message: i.message }));
}

// GET /api/mcp            -> configured servers
// GET /api/mcp?discover=1 -> servers + live tool discovery across enabled ones
export async function GET(req: Request) {
  const denied = await secure(req);
  if (denied instanceof Response) return denied;

  const servers = listMcpServers();
  if (new URL(req.url).searchParams.get("discover") !== "1") {
    return Response.json({ servers });
  }
  const { tools, errors } = await discoverAllTools();
  return Response.json({ servers, tools, errors });
}

const addSchema = z
  .object({
    action: z.literal("add"),
    name: z.string().trim().min(1).max(80),
    transport: z.enum(["http", "sse", "stdio"]),
    url: z.string().trim().url().optional(),
    command: z.string().trim().min(1).optional(),
    args: z.array(z.string()).max(50).optional(),
    env: z.record(z.string(), z.string()).optional(),
  })
  .strict();

const toggleSchema = z
  .object({ action: z.literal("toggle"), id: z.string().min(1), enabled: z.boolean() })
  .strict();

const callSchema = z
  .object({
    action: z.literal("call"),
    serverId: z.string().min(1),
    tool: z.string().min(1),
    args: z.record(z.string(), z.unknown()).default({}),
  })
  .strict();

const bodySchema = z.discriminatedUnion("action", [addSchema, toggleSchema, callSchema]);

export async function POST(req: Request) {
  const denied = await secure(req);
  if (denied instanceof Response) return denied;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return badRequest("Request body must be valid JSON.");
  }
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) return badRequest("Invalid request body.", issues(parsed.error));
  const data = parsed.data;

  if (data.action === "add") {
    try {
      const server = addMcpServer(data);
      return Response.json({ server }, { status: 201 });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const status = /UNIQUE/i.test(message) ? 409 : 400;
      return Response.json(
        { error: { message: status === 409 ? "A server with that name already exists." : message } },
        { status },
      );
    }
  }

  if (data.action === "toggle") {
    if (!setMcpServerEnabled(data.id, data.enabled)) {
      return Response.json({ error: { message: "MCP server not found." } }, { status: 404 });
    }
    return Response.json({ ok: true });
  }

  const started = Date.now();
  try {
    const result = await callMcpTool(data.serverId, data.tool, data.args);
    return Response.json({ result, durationMs: Date.now() - started });
  } catch (err) {
    return Response.json(
      { error: { message: err instanceof Error ? err.message : String(err) } },
      { status: 502 },
    );
  }
}

export async function DELETE(req: Request) {
  const denied = await secure(req);
  if (denied instanceof Response) return denied;

  const id = new URL(req.url).searchParams.get("id");
  if (!id) return badRequest("id query parameter is required.");
  if (!deleteMcpServer(id)) {
    return Response.json({ error: { message: "MCP server not found." } }, { status: 404 });
  }
  return new Response(null, { status: 204 });
}
