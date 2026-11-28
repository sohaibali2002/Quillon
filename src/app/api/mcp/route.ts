async function secure(req: Request) {
  const gate = await guard(req, { role: "admin" });
  if (gate instanceof Response) return gate;
  return gate;
}

import { z } from "zod";
import { guard, auditStrict, orgForSession, capabilitySubject } from "@/lib/guard";
import { enforceRateLimit } from "@/lib/rate-limit";
import { safeErrorMessage } from "@/lib/sanitize";
import {
  addMcpServer,
  approveMcpToolPin,
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
  const tenant = orgForSession(denied);

  const servers = listMcpServers(tenant);
  if (new URL(req.url).searchParams.get("discover") !== "1") {
    return Response.json({ servers });
  }
  const { tools, errors } = await discoverAllTools(tenant);
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

const approveSchema = z
  .object({ action: z.literal("approve-tools"), id: z.string().min(1) })
  .strict();

const bodySchema = z.discriminatedUnion("action", [addSchema, toggleSchema, callSchema, approveSchema]);

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
  const gate = denied;
  const tenant = orgForSession(gate);
  const limited = enforceRateLimit(capabilitySubject(gate), "mcp", 120, 60_000);
  if (limited) return limited;

  if (data.action === "add") {
    try {
      const server = await addMcpServer(data, tenant);
      auditStrict(req, gate, "mcp.add", `mcp:${server.id}`, {
        name: server.name,
        transport: server.transport,
      });
      return Response.json({ server }, { status: 201 });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const status = /UNIQUE/i.test(message) ? 409 : 400;
      return Response.json(
        {
          error: {
            message:
              status === 409
                ? "A server with that name already exists."
                : safeErrorMessage(err, "Could not add the MCP server."),
          },
        },
        { status },
      );
    }
  }

  if (data.action === "approve-tools") {
    if (!approveMcpToolPin(data.id, tenant)) {
      return Response.json({ error: { message: "MCP server not found." } }, { status: 404 });
    }
    auditStrict(req, gate, "mcp.approve_tools", `mcp:${data.id}`, { serverId: data.id });
    return Response.json({ ok: true });
  }

  if (data.action === "toggle") {
    if (!setMcpServerEnabled(data.id, data.enabled, tenant)) {
      return Response.json({ error: { message: "MCP server not found." } }, { status: 404 });
    }
    auditStrict(req, gate, data.enabled ? "mcp.enable" : "mcp.disable", `mcp:${data.id}`, {});
    return Response.json({ ok: true });
  }

  const started = Date.now();
  try {
    const result = await callMcpTool(data.serverId, data.tool, data.args, tenant);
    return Response.json({ result, durationMs: Date.now() - started });
  } catch (err) {
    // Raw server exceptions can carry internal URLs, tokens or stack details;
    // the desk gets the sanitized message only.
    return Response.json(
      { error: { message: safeErrorMessage(err, `Calling "${data.tool}" failed.`) } },
      { status: 502 },
    );
  }
}

export async function DELETE(req: Request) {
  const gate = await secure(req);
  if (gate instanceof Response) return gate;

  const id = new URL(req.url).searchParams.get("id");
  if (!id) return badRequest("id query parameter is required.");
  if (!deleteMcpServer(id, orgForSession(gate))) {
    return Response.json({ error: { message: "MCP server not found." } }, { status: 404 });
  }
  auditStrict(req, gate, "mcp.delete", `mcp:${id}`, {});
  return new Response(null, { status: 204 });
}
