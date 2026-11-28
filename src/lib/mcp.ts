// Model Context Protocol support: the platform connects to MCP servers
// (streamable HTTP, SSE or stdio), discovers their tools and merges them into
// the chat/agent tool loop through @ai-sdk/mcp.
import { createMCPClient } from "@ai-sdk/mcp";
import { assertPublicDestination, egressAllowlist, guardedFetch, urlCredentialReason } from "@/lib/net-guard";
import { StdioMCPTransport } from "@ai-sdk/mcp/mcp-stdio";
import type { ToolSet } from "ai";
import { createHash, randomUUID } from "node:crypto";
import { getDb } from "@/lib/db";
import { encryptToken, decryptToken, connectorsSecret } from "@/lib/connectors";
import { tenantScope } from "@/lib/tenant-context";

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

export function listMcpServers(tenant?: string): McpServer[] {
  const scope = tenantScope(tenant);
  return (
    getDb()
      .prepare("SELECT * FROM mcp_servers WHERE tenant_id = ? ORDER BY created_at ASC")
      .all(scope) as McpServerRow[]
  ).map(fromRow);
}

export function getMcpServer(id: string, tenant?: string): McpServer | null {
  const row = getDb()
    .prepare("SELECT * FROM mcp_servers WHERE id = ? AND tenant_id = ?")
    .get(id, tenantScope(tenant)) as McpServerRow | undefined;
  return row ? fromRow(row) : null;
}

export async function addMcpServer(input: {
  name: string;
  transport: McpTransportType;
  url?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
}, tenant?: string): Promise<McpServer> {
  const name = input.name.trim().slice(0, 80);
  if (!name) throw new Error("Server name is required.");
  if (input.transport !== "stdio") {
    if (!input.url || !/^https?:\/\//i.test(input.url)) {
      throw new Error(`${input.transport} transport needs an http(s) url.`);
    }
    validateMcpUrl(input.url);
    // Registration checks DNS now so a hostname that only resolves to internal
    // addresses never reaches the database; the transport re-checks per connect.
    await assertPublicDestination(input.url, { allowPrivate: localMcpAllowed() });
  } else if (!input.command?.trim()) {
    throw new Error("stdio transport needs a command.");
  } else {
    validateStdioCommand(input.command.trim());
    validateStdioArgs(input.command.trim(), input.args ?? []);
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
      "INSERT INTO mcp_servers (id, tenant_id, name, transport, url, command, args, env, enabled, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)",
    )
    .run(
      server.id,
      tenantScope(tenant),
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

export function setMcpServerEnabled(id: string, enabled: boolean, tenant?: string): boolean {
  const changes = getDb()
    .prepare("UPDATE mcp_servers SET enabled = ? WHERE id = ? AND tenant_id = ?")
    .run(enabled ? 1 : 0, id, tenantScope(tenant)).changes;
  if (Number(changes) > 0) invalidateMcpCache(id);
  return Number(changes) > 0;
}

export function deleteMcpServer(id: string, tenant?: string): boolean {
  const changes = getDb()
    .prepare("DELETE FROM mcp_servers WHERE id = ? AND tenant_id = ?")
    .run(id, tenantScope(tenant)).changes;
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
  const credential = urlCredentialReason(parsed);
  if (credential) throw new Error(credential);
  const allow = egressAllowlist();
  const hostname = parsed.hostname.toLowerCase().replace(/\.+$/, "");
  if (allow.length && !allow.some((h) => hostname === h || hostname.endsWith(`.${h}`))) {
    throw new Error(`MCP host "${parsed.hostname}" is not on QUILLON_MCP_ALLOWED_HOSTS.`);
  }
}

/** Local/private MCP servers are opt-in; the default policy is public egress only. */
function localMcpAllowed(): boolean {
  return process.env.QUILLON_MCP_ALLOW_PRIVATE === "1";
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

// An allowlisted executable is not automatically safe: what matters is the
// arguments it is given. These are the flags that would hand a container the
// host (or its credentials) and the credential patterns that belong in env.
const DANGEROUS_CONTAINER_FLAGS: RegExp[] = [
  /^--privileged$/,
  /^--cap-add(=|$)/,
  /^--net(work)?=host$/,
  /^--pid=host$/,
  /^--ipc=host$/,
  /^--userns=host$/,
  /^--security-opt(=|$)/,
  /^--device(=|$)/,
  /^--mount(=|$)/,
  /^--volumes-from(=|$)/,
  /^-v$/,
  /^--volume(=|$)/,
];
const PROTECTED_MOUNT = /(^|[=:,])(\/|~\/|\/var\/run|\/etc|\/proc|\/sys|docker\.sock|\.ssh|\.aws|\.gnupg|\.config)/i;

function looksLikeSecret(arg: string): boolean {
  if (/^--?(api[-_]?key|token|secret|password|passwd|auth|authorization|bearer)(=|:|$)/i.test(arg)) return true;
  return /\b(sk-[A-Za-z0-9]{12,}|ghp_[A-Za-z0-9]{12,}|xox[abp]-[A-Za-z0-9-]{10,}|Bearer\s+[A-Za-z0-9._-]{12,})/.test(arg);
}

export function validateStdioArgs(command: string, args: string[]): void {
  const base = command.split("/").pop() ?? command;
  for (const arg of args) {
    if (arg.length > 500) throw new Error("stdio argument is too long.");
    if (/[\u0000\n\r]/.test(arg)) throw new Error("stdio arguments must not contain control characters.");
    if (looksLikeSecret(arg)) {
      throw new Error(
        "stdio arguments appear to contain a credential; pass secrets through the encrypted env field instead.",
      );
    }
    if (base === "docker") {
      if (DANGEROUS_CONTAINER_FLAGS.some((re) => re.test(arg))) {
        throw new Error(`docker argument "${arg}" grants host access and is not allowed.`);
      }
      if (PROTECTED_MOUNT.test(arg)) {
        throw new Error(`docker argument "${arg}" mounts a protected host path and is not allowed.`);
      }
    }
  }
  // A registry launcher without a pinned version can change after approval.
  if (process.env.QUILLON_MCP_STRICT_PINS === "0") return;
  if (base === "npx" || base === "uvx") {
    const pkg = args.find((a) => !a.startsWith("-") && !/^(run|exec|--yes|-y|--no-install)$/.test(a));
    if (pkg && !/[@=]\d/.test(pkg)) {
      throw new Error(
        `${base} package "${pkg}" must pin a version (name@1.2.3) so an approved server cannot change underneath you. Set QUILLON_MCP_STRICT_PINS=0 to opt out.`,
      );
    }
  }
}

// Environment variables hold credentials, so they are encrypted at rest with
// the connector-token cipher and only decrypted for the transport.
function sealEnv(env: Record<string, string>): string {
  return JSON.stringify(Object.fromEntries(Object.entries(env).map(([k, v]) => [k, encryptToken(connectorsSecret(), v)])));
}

// Our sealed format is iv.tag.ciphertext with a 12-byte iv (16 base64url chars)
// and a 16-byte tag (22 chars). That shape is what separates a blob we must be
// able to decrypt from a legacy plaintext value such as a JWT or an API key.
function looksSealed(value: string): boolean {
  const parts = value.split(".");
  return parts.length === 3 && parts[0].length === 16 && parts[1].length === 22 && parts[2].length > 0;
}

function openEnv(stored: string): Record<string, string> {
  let parsed: Record<string, string>;
  try {
    parsed = JSON.parse(stored) as Record<string, string>;
  } catch {
    return {};
  }
  const entries = Object.entries(parsed);
  if (entries.length === 0) return {};
  const secret = connectorsSecret();
  return Object.fromEntries(
    entries.map(([k, v]) => {
      if (typeof v !== "string") throw new Error(`MCP environment variable ${k} is not a string.`);
      try {
        return [k, decryptToken(secret, v)];
      } catch {
        // A value in the sealed format that will not decrypt is a key mismatch
        // or tampering: refuse the server instead of passing the ciphertext (or
        // whatever else it is) to the process as a credential. Only values that
        // are not in the sealed format can be legacy plaintext.
        if (looksSealed(v)) {
          throw new Error(`MCP environment variable ${k} cannot be decrypted with the current key; re-save this server.`);
        }
        return [k, v];
      }
    }),
  );
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
        // Redirects are followed by the guard, which revalidates every hop
        // instead of letting the transport chase a 30x into the internal network.
        fetch: (input: RequestInfo | URL, init?: RequestInit) =>
          guardedFetch(input, { ...init, policy: { allowPrivate: localMcpAllowed() } }),
      };
}

async function acquireClient(server: McpServer): Promise<McpClient> {
  const fingerprint = serverFingerprint(server);
  const pooled = clientPool.get(server.id);
  if (pooled && pooled.fingerprint === fingerprint) return pooled.client;
  if (pooled) dropClient(server.id);
  if (server.transport !== "stdio" && server.url) {
    // Re-resolve at connect time: a hostname that passed registration can be
    // repointed afterwards, and this is the check the socket will follow.
    await assertPublicDestination(server.url, { allowPrivate: localMcpAllowed() });
  }
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

// Transport-level failures are worth one reconnect — but only while
// establishing the connection or listing tools. Once a tool invocation has been
// handed to the client, `fn` is marked started and the caller never retries it:
// the tool may have taken effect and the error may be nothing more than a lost
// response, so a replay would duplicate the write.
function isConnectionError(error: unknown): boolean {
  const msg = error instanceof Error ? error.message : String(error);
  return /closed|disconnect|not connected|terminated|socket|ECONN|EPIPE|fetch failed|network/i.test(msg);
}

async function withServerClient<T>(server: McpServer, fn: (client: McpClient) => Promise<T>): Promise<T> {
  let started = false;
  const guarded = (client: McpClient) => {
    const wrapped = fn(client);
    // Mark as started on the next tick so connection-establishment failures
    // (rejected before any I/O on the tool call) can still retry once.
    void wrapped.then(
      () => {},
      () => {},
    );
    started = true;
    return wrapped;
  };
  try {
    return await guarded(await acquireClient(server));
  } catch (error) {
    if (started || !isConnectionError(error)) throw error;
    dropClient(server.id);
    return guarded(await acquireClient(server));
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
  verifyToolPin(server, descriptors);
  toolCache.set(server.id, { fingerprint, at: Date.now(), tools: descriptors });
  return descriptors;
}

function toolPinHash(descriptors: Record<string, { description?: string; inputSchema?: unknown }>): string {
  const canonical = Object.keys(descriptors)
    .sort()
    .map((name) => [name, descriptors[name].description ?? "", descriptors[name].inputSchema ?? {}]);
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

/**
 * Trust on first use, then detect drift. A server that redefines its tool names,
 * descriptions or schemas after approval must be approved again, so a
 * compromised server cannot quietly repurpose a tool the model already trusts.
 */
export function verifyToolPin(
  server: McpServer,
  descriptors: Record<string, { description?: string; inputSchema?: unknown }>,
): void {
  const hash = toolPinHash(descriptors);
  const row = getDb().prepare("SELECT tool_pin FROM mcp_servers WHERE id = ?").get(server.id) as
    | { tool_pin: string | null }
    | undefined;
  if (!row) return;
  if (!row.tool_pin) {
    getDb().prepare("UPDATE mcp_servers SET tool_pin = ? WHERE id = ?").run(hash, server.id);
    return;
  }
  if (row.tool_pin !== hash) {
    throw new Error(
      `MCP server "${server.name}" changed its tool definitions since approval and is disabled until an admin re-approves it.`,
    );
  }
}

/** Clears the pin so the next discovery records the current tool definitions. */
export function approveMcpToolPin(id: string, tenant?: string): boolean {
  const changes = getDb()
    .prepare("UPDATE mcp_servers SET tool_pin = NULL WHERE id = ? AND tenant_id = ?")
    .run(id, tenantScope(tenant)).changes;
  invalidateMcpCache();
  return Number(changes) > 0;
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
          // Re-verify the pin against the LIVE descriptors immediately before
          // the invocation. Discovery-time checking alone leaves a window in
          // which a compromised server can serve one schema to the planner and
          // execute something else.
          const live = Object.fromEntries(
            Object.entries(toolSet).map(([n, t]) => [
              n,
              {
                description: (t as { description?: string }).description,
                inputSchema: (t as { inputSchema?: unknown }).inputSchema,
              },
            ]),
          );
          verifyToolPin(server, live as Parameters<typeof verifyToolPin>[1]);
          // No retry wraps this call: once the invocation starts, an error may
          // mean the write landed and the response was lost.
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
export async function discoverAllTools(tenant?: string): Promise<{
  tools: DiscoveredTool[];
  errors: { server: string; message: string }[];
}> {
  const servers = listMcpServers(tenantScope(tenant)).filter((s) => s.enabled);
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
export async function mcpToolset(tenant?: string): Promise<{
  tools: ToolSet;
  errors: { server: string; message: string }[];
}> {
  const servers = listMcpServers(tenantScope(tenant)).filter((s) => s.enabled);
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
  tenant?: string,
): Promise<unknown> {
  const server = getMcpServer(serverId, tenantScope(tenant));
  if (!server) throw new Error("Unknown MCP server.");
  if (!server.enabled) throw new Error(`MCP server "${server.name}" is disabled.`);
  return withServerClient(server, async (client) => {
    const toolSet = await withTimeout(client.tools(), `list tools on "${server.name}"`);
    const impl = toolSet[toolName];
    if (!impl || typeof (impl as { execute?: unknown }).execute !== "function") {
      throw new Error(`Tool "${toolName}" was not found on "${server.name}".`);
    }
    // Same execution-time pin check as the chat loop: the manual desk must not
    // become the bypass around a changed tool definition.
    const live = Object.fromEntries(
      Object.entries(toolSet).map(([n, t]) => [
        n,
        {
          description: (t as { description?: string }).description,
          inputSchema: (t as { inputSchema?: unknown }).inputSchema,
        },
      ]),
    );
    verifyToolPin(server, live as Parameters<typeof verifyToolPin>[1]);
    return withTimeout(
      impl.execute(args, { toolCallId: randomUUID(), messages: [], context: {} }) as Promise<unknown>,
      `call "${toolName}"`,
    );
  });
}
