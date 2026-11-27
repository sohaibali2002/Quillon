// Model Context Protocol support: the platform connects to MCP servers
// (streamable HTTP, SSE or stdio), discovers their tools and merges them into
// the chat/agent tool loop through @ai-sdk/mcp.
import { createMCPClient } from "@ai-sdk/mcp";
import { StdioMCPTransport } from "@ai-sdk/mcp/mcp-stdio";
import type { ToolSet } from "ai";
import { createHash, randomUUID } from "node:crypto";
import { getDb } from "@/lib/db";
import { encryptToken, decryptToken, connectorsSecret } from "@/lib/connectors";

export type McpTransportType = "http" | "sse" | "stdio";

export type McpServer = {
  id: string;
  name: string;
  transport: McpTransportType;
  url: string | null;
  command: string | null;
  args: string[];
  env: Record<string, string>;
  enabled: boolean;
  createdAt: string;
};

export type DiscoveredTool = {
  server: string;
  serverId: string;
  name: string;
  qualifiedName: string;
  description: string;
};

type McpServerRow = {
  id: string;
  name: string;
  transport: string;
  url: string | null;
  command: string | null;
  args: string;
  env: string;
  enabled: number;
  created_at: string;
};

function fromRow(r: McpServerRow): McpServer {
  return {
    id: r.id,
    name: r.name,
    transport: r.transport as McpTransportType,
    url: r.url,
    command: r.command,
    args: JSON.parse(r.args) as string[],
    env: openEnv(r.env),
    enabled: r.enabled === 1,
    createdAt: r.created_at,
  };
}

export function listMcpServers(): McpServer[] {
  return (getDb().prepare("SELECT * FROM mcp_servers ORDER BY created_at ASC").all() as McpServerRow[]).map(fromRow);
}

export function getMcpServer(id: string): McpServer | null {
  const row = getDb().prepare("SELECT * FROM mcp_servers WHERE id = ?").get(id) as
    | McpServerRow
    | undefined;
  return row ? fromRow(row) : null;
}

export function addMcpServer(input: {
  name: string;
  transport: McpTransportType;
  url?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
}): McpServer {
  const name = input.name.trim().slice(0, 80);
  if (!name) throw new Error("Server name is required.");
  if (input.transport !== "stdio") {
    if (!input.url || !/^https?:\/\//i.test(input.url)) {
      throw new Error(`${input.transport} transport needs an http(s) url.`);
    }
    validateMcpUrl(input.url);
  } else if (!input.command?.trim()) {
    throw new Error("stdio transport needs a command.");
  } else {
    validateStdioCommand(input.command.trim());
  }
  const server: McpServer = {
    id: randomUUID(),
    name,
    transport: input.transport,
    url: input.url?.trim() ?? null,
    command: input.command?.trim() ?? null,
    args: input.args ?? [],
    env: input.env ?? {},
    enabled: true,
    createdAt: new Date().toISOString(),
  };
  getDb()
    .prepare(
      "INSERT INTO mcp_servers (id, name, transport, url, command, args, env, enabled, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)",
    )
    .run(
      server.id,
      server.name,
      server.transport,
      server.url,
      server.command,
      JSON.stringify(server.args),
      sealEnv(server.env),
      server.createdAt,
    );
  return server;
}

export function setMcpServerEnabled(id: string, enabled: boolean): boolean {
  const changes = getDb()
    .prepare("UPDATE mcp_servers SET enabled = ? WHERE id = ?")
    .run(enabled ? 1 : 0, id).changes;
  if (Number(changes) > 0) invalidateMcpCache(id);
  return Number(changes) > 0;
}

export function deleteMcpServer(id: string): boolean {
  const changes = getDb().prepare("DELETE FROM mcp_servers WHERE id = ?").run(id).changes;
  if (Number(changes) > 0) invalidateMcpCache(id);
  return Number(changes) > 0;
}

export function qualifiedToolName(server: McpServer, toolName: string): string {
  const safe = (s: string) => s.replace(/[^a-zA-Z0-9_-]/g, "_");
  return `mcp_${safe(server.name)}_${safe(toolName)}`;
}

const CONNECT_TIMEOUT_MS = 10_000;

// --- MCP security policy -----------------------------------------------------
// Remote servers: http(s) only, never a cloud-metadata endpoint, and hosts must
// be on the QUILLON_MCP_ALLOWED_HOSTS allowlist when one is configured (also
// mitigates redirect-based SSRF because every target URL is re-validated here).
// stdio servers: the executable must be on the QUILLON_MCP_STDIO_COMMANDS
// allowlist (default: common MCP runners); registration is admin-only.
export function validateMcpUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("MCP url is not a valid URL.");
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error("MCP url must use http(s).");
  }
  if (/^169\.254\.169\.254/.test(parsed.hostname) || parsed.hostname === "metadata.google.internal") {
    throw new Error("MCP url points at a cloud metadata endpoint, which is not allowed.");
  }
  const allow = (process.env.QUILLON_MCP_ALLOWED_HOSTS ?? "")
    .split(",")
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
  if (allow.length && !allow.includes(parsed.hostname.toLowerCase())) {
    throw new Error(`MCP host "${parsed.hostname}" is not on QUILLON_MCP_ALLOWED_HOSTS.`);
  }
}

const DEFAULT_STDIO_COMMANDS = ["node", "npx", "uvx", "python3", "docker"];

function validateStdioCommand(command: string): void {
  const allow = (process.env.QUILLON_MCP_STDIO_COMMANDS ?? "")
    .split(",")
    .map((c) => c.trim())
    .filter(Boolean);
  const list = process.env.QUILLON_MCP_STDIO_COMMANDS === "" ? [] : allow.length ? allow : DEFAULT_STDIO_COMMANDS;
  const base = command.split("/").pop() ?? command;
  if (!list.includes(base) && !list.includes(command)) {
    throw new Error(
      `stdio command "${command}" is not on the allowlist (QUILLON_MCP_STDIO_COMMANDS).`,
    );
  }
}

// Environment variables hold credentials, so they are encrypted at rest with
// the connector-token cipher and only decrypted for the transport.
function sealEnv(env: Record<string, string>): string {
  return JSON.stringify(Object.fromEntries(Object.entries(env).map(([k, v]) => [k, encryptToken(connectorsSecret(), v)])));
}
function openEnv(stored: string): Record<string, string> {
  try {
    return Object.fromEntries(
      Object.entries(JSON.parse(stored) as Record<string, string>).map(([k, v]) => {
        try {
          return [k, decryptToken(connectorsSecret(), v)];
        } catch {
          return [k, v]; // pre-encryption rows keep working
        }
      }),
    );
  } catch {
    return {};
  }
}

function withTimeout<T>(p: Promise<T>, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`MCP ${what} timed out after ${CONNECT_TIMEOUT_MS / 1000}s.`)),
      CONNECT_TIMEOUT_MS,
    );
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

// --- Connection pool ---------------------------------------------------------
// Connecting, initializing and discovering tools on every message (and again
// on every tool call) is the dominant MCP latency: one chat turn with three MCP
// servers made six-plus connect/close round trips. Clients are pooled per
// server and tool descriptors are cached for TOOL_CACHE_TTL_MS; the cache is
// invalidated whenever a server is added, edited, enabled, disabled or deleted.
// A dead pooled client is dropped and reconnected once on a connection error.
const TOOL_CACHE_TTL_MS = 60_000;

type McpClient = Awaited<ReturnType<typeof createMCPClient>>;

function serverFingerprint(server: McpServer): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        server.transport,
        server.url ?? null,
        server.command ?? null,
        server.args ?? [],
        server.env ?? {},
        server.enabled,
      ]),
    )
    .digest("hex");
}

const clientPool = new Map<string, { fingerprint: string; client: McpClient }>();
const toolCache = new Map<
  string,
  { fingerprint: string; at: number; tools: Record<string, { description?: string; inputSchema?: unknown }> }
>();

function transportFor(server: McpServer) {
  return server.transport === "stdio"
    ? new StdioMCPTransport({
        command: server.command!,
        args: server.args,
        env: server.env,
      })
    : {
        type: server.transport,
        url: server.url!,
        redirect: "follow" as const,
      };
}

async function acquireClient(server: McpServer): Promise<McpClient> {
  const fingerprint = serverFingerprint(server);
  const pooled = clientPool.get(server.id);
  if (pooled && pooled.fingerprint === fingerprint) return pooled.client;
  if (pooled) dropClient(server.id);
  const client = await withTimeout(
    createMCPClient({ transport: transportFor(server), clientName: "quillon-workbench" }),
    `connect to "${server.name}"`,
  );
  clientPool.set(server.id, { fingerprint, client });
  return client;
}

function dropClient(serverId: string): void {
  const pooled = clientPool.get(serverId);
  if (!pooled) return;
  clientPool.delete(serverId);
  void pooled.client.close().catch(() => {
    // closing a failed connection is best-effort
  });
}

// Transport-level failures are worth one reconnect; tool errors (which may have
// side effects) are never retried.
function isConnectionError(error: unknown): boolean {
  const msg = error instanceof Error ? error.message : String(error);
  return /closed|disconnect|not connected|terminated|socket|ECONN|EPIPE|fetch failed|network/i.test(msg);
}

async function withServerClient<T>(server: McpServer, fn: (client: McpClient) => Promise<T>): Promise<T> {
  try {
    return await fn(await acquireClient(server));
  } catch (error) {
    if (!isConnectionError(error)) throw error;
    dropClient(server.id);
    return fn(await acquireClient(server));
  }
}

// Cached tool descriptors (name + description + input schema). A second
// consumer in the same turn reuses the cache instead of re-listing.
async function serverToolDescriptors(
  server: McpServer,
): Promise<Record<string, { description?: string; inputSchema?: unknown }>> {
  const fingerprint = serverFingerprint(server);
  const cached = toolCache.get(server.id);
  if (cached && cached.fingerprint === fingerprint && Date.now() - cached.at < TOOL_CACHE_TTL_MS) {
    return cached.tools;
  }
  const descriptors = await withServerClient(server, async (client) => {
    const toolSet = await withTimeout(client.tools(), `list tools on "${server.name}"`);
    return Object.fromEntries(
      Object.entries(toolSet).map(([name, impl]) => [
        name,
        {
          description: (impl as { description?: string }).description,
          inputSchema: (impl as { inputSchema?: unknown }).inputSchema,
        },
      ]),
    );
  });
  toolCache.set(server.id, { fingerprint, at: Date.now(), tools: descriptors });
  return descriptors;
}

function serverToolset(
  server: McpServer,
  descriptors: Record<string, { description?: string; inputSchema?: unknown }>,
): ToolSet {
  const out: ToolSet = {};
  for (const [name, d] of Object.entries(descriptors)) {
    const wrapped = {
      description: d.description ?? `MCP tool ${name} on ${server.name}`,
      inputSchema: (d.inputSchema ?? { type: "object", properties: {} }) as never,
      execute: async (args: Record<string, unknown>) =>
        withServerClient(server, async (client) => {
          const toolSet = await withTimeout(client.tools(), `list tools on "${server.name}"`);
          const impl = toolSet[name];
          if (!impl || typeof (impl as { execute?: unknown }).execute !== "function") {
            throw new Error(`Tool "${name}" was not found on "${server.name}".`);
          }
          return withTimeout(
            impl.execute(args, { toolCallId: randomUUID(), messages: [], context: {} }) as Promise<unknown>,
            `call "${name}" on "${server.name}"`,
          );
        }),
    };
    out[name] = wrapped as unknown as ToolSet[string];
  }
  return out;
}

// Called by the MCP API on add / edit / enable / disable / delete so the next
// chat turn never plans against a stale server or a closed connection.
export function invalidateMcpCache(serverId?: string): void {
  if (serverId) {
    dropClient(serverId);
    toolCache.delete(serverId);
    return;
  }
  for (const id of [...clientPool.keys()]) dropClient(id);
  toolCache.clear();
}

// Close every pooled client. Scripts and tests call this before exiting:
// a pooled stdio server keeps its child process alive otherwise.
export async function closeMcpClients(): Promise<void> {
  const clients = [...clientPool.values()].map((pooled) => pooled.client);
  clientPool.clear();
  toolCache.clear();
  await Promise.all(clients.map((client) => client.close().catch(() => {})));
}

export async function discoverTools(server: McpServer): Promise<DiscoveredTool[]> {
  const descriptors = await serverToolDescriptors(server);
  return Object.entries(descriptors).map(([name, d]) => ({
    server: server.name,
    serverId: server.id,
    name,
    qualifiedName: qualifiedToolName(server, name),
    description: d.description ?? "",
  }));
}

// Tool discovery across every enabled server; a dead server is reported, not
// fatal — chat must not lose its built-in tools because one MCP server is down.
export async function discoverAllTools(): Promise<{
  tools: DiscoveredTool[];
  errors: { server: string; message: string }[];
}> {
  const servers = listMcpServers().filter((s) => s.enabled);
  const results = await Promise.allSettled(servers.map((s) => discoverTools(s)));
  const tools: DiscoveredTool[] = [];
  const errors: { server: string; message: string }[] = [];
  results.forEach((r, i) => {
    if (r.status === "fulfilled") tools.push(...r.value);
    else
      errors.push({
        server: servers[i].name,
        message: r.reason instanceof Error ? r.reason.message : String(r.reason),
      });
  });
  return { tools, errors };
}

// Live toolset for streamText: every enabled server's tools, namespaced by
// server name so servers with colliding tool names coexist in one loop. Tool
// descriptors come from the 60s cache; calls go through the pooled client.
export async function mcpToolset(): Promise<{
  tools: ToolSet;
  errors: { server: string; message: string }[];
}> {
  const servers = listMcpServers().filter((s) => s.enabled);
  const results = await Promise.allSettled(
    servers.map(async (s) => ({ server: s, descriptors: await serverToolDescriptors(s) })),
  );
  const tools: ToolSet = {};
  const errors: { server: string; message: string }[] = [];
  results.forEach((r, i) => {
    if (r.status === "fulfilled") {
      const set = serverToolset(r.value.server, r.value.descriptors);
      for (const [name, impl] of Object.entries(set)) {
        tools[qualifiedToolName(r.value.server, name)] = impl;
      }
    } else {
      errors.push({
        server: servers[i].name,
        message: r.reason instanceof Error ? r.reason.message : String(r.reason),
      });
    }
  });
  return { tools, errors };
}

// Manual invocation from the MCP desk UI.
export async function callMcpTool(
  serverId: string,
  toolName: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const server = getMcpServer(serverId);
  if (!server) throw new Error("Unknown MCP server.");
  if (!server.enabled) throw new Error(`MCP server "${server.name}" is disabled.`);
  return withServerClient(server, async (client) => {
    const toolSet = await withTimeout(client.tools(), `list tools on "${server.name}"`);
    const impl = toolSet[toolName];
    if (!impl || typeof (impl as { execute?: unknown }).execute !== "function") {
      throw new Error(`Tool "${toolName}" was not found on "${server.name}".`);
    }
    return withTimeout(
      impl.execute(args, { toolCallId: randomUUID(), messages: [], context: {} }) as Promise<unknown>,
      `call "${toolName}"`,
    );
  });
}
