// Agent memory: facts persisted to sqlite and recalled into the model context.
// Two scopes: "conversation" (one thread) and "agent" (durable across threads).
// The model writes memories itself through the remember/recall tools.
//
// Isolation: every read and write is scoped to the authenticated (tenant,
// owner) pair. A conversation id is claimed by the identity that first uses it;
// a request presenting another identity's id silently gets a fresh thread
// instead of that conversation's memories, so ids are not a capability.
import { createHash, randomUUID } from "node:crypto";
import { tool } from "ai";
import { z } from "zod";
import { getDb } from "@/lib/db";

export type MemoryScope = "conversation" | "agent";

export type MemoryIdentity = { tenant: string; owner: string };

export type MemoryRecord = {
  id: string;
  conversationId: string;
  scope: MemoryScope;
  content: string;
  createdAt: string;
};

export const MAX_MEMORY_CHARS = 2000;
export const MAX_MEMORIES = 200;

// Server-issued conversation ids: uuid or a short opaque token. Anything else
// (an injected path, a SQL fragment, a huge string) is replaced with a fresh id.
const CONVERSATION_ID = /^[A-Za-z0-9_-]{8,128}$/;

function normalise(identity: MemoryIdentity): MemoryIdentity {
  const tenant = identity.tenant.trim();
  const owner = identity.owner.trim();
  if (!tenant || !owner) throw new Error("Memory identity must carry a tenant and an owner.");
  return { tenant, owner };
}

function ownedBy(id: string, identity: MemoryIdentity): boolean {
  const row = getDb()
    .prepare("SELECT tenant_id, owner_id FROM conversations WHERE id = ?")
    .get(id) as { tenant_id: string; owner_id: string } | undefined;
  return Boolean(row && row.tenant_id === identity.tenant && row.owner_id === identity.owner);
}

function claim(id: string, identity: MemoryIdentity): void {
  getDb()
    .prepare("INSERT OR IGNORE INTO conversations (id, tenant_id, owner_id) VALUES (?, ?, ?)")
    .run(id, identity.tenant, identity.owner);
}

/**
 * A client that sends no conversation id (or the legacy "default") gets one
 * stable thread per identity, not one shared thread for the whole server.
 */
export function defaultConversationId(identity: MemoryIdentity): string {
  const who = normalise(identity);
  const digest = createHash("sha256").update(`${who.tenant}\u0000${who.owner}`).digest("hex").slice(0, 24);
  return `thread_${digest}`;
}

/**
 * The conversation id this request may use. A valid id already claimed by the
 * caller is reused; an id claimed by another identity is never reused (a fresh
 * thread is issued instead, so the caller cannot probe for its existence).
 */
export function resolveConversation(identity: MemoryIdentity, requested?: string | null): string {
  const who = normalise(identity);
  if (!requested || requested === "default") return claimAndReturn(defaultConversationId(who), who);
  if (CONVERSATION_ID.test(requested)) {
    if (!ownedBy(requested, who)) {
      const exists = getDb().prepare("SELECT 1 FROM conversations WHERE id = ?").get(requested);
      if (!exists) return claimAndReturn(requested, who);
    } else {
      return requested;
    }
  }
  return claimAndReturn(randomUUID(), who);
}

function claimAndReturn(id: string, identity: MemoryIdentity): string {
  claim(id, identity);
  return id;
}

/** Throws unless the conversation belongs to this identity (or was just claimed). */
export function assertConversationOwner(identity: MemoryIdentity, conversationId: string): void {
  const who = normalise(identity);
  if (!CONVERSATION_ID.test(conversationId) || !ownedBy(conversationId, who)) {
    throw new Error("Unknown conversation.");
  }
}

export function listMemories(
  identity: MemoryIdentity,
  opts: { conversationId?: string; scope?: MemoryScope } = {},
): MemoryRecord[] {
  const who = normalise(identity);
  const db = getDb();
  const where: string[] = ["tenant_id = ?", "owner_id = ?"];
  const params: string[] = [who.tenant, who.owner];
  if (opts.conversationId) {
    // Agent-scope facts are shared across this owner's threads, never across
    // owners: the tenant/owner filters above still apply to that branch.
    where.push("(conversation_id = ? OR scope = 'agent')");
    params.push(opts.conversationId);
  }
  if (opts.scope) {
    where.push("scope = ?");
    params.push(opts.scope);
  }
  const sql = `SELECT id, conversation_id, scope, content, created_at FROM memories
    WHERE ${where.join(" AND ")}
    ORDER BY created_at DESC, id DESC LIMIT ${MAX_MEMORIES}`;
  return db
    .prepare(sql)
    .all(...params)
    .map((r) => ({
      id: String(r.id),
      conversationId: String(r.conversation_id),
      scope: r.scope as MemoryScope,
      content: String(r.content),
      createdAt: String(r.created_at),
    }));
}

export function addMemory(
  identity: MemoryIdentity,
  content: string,
  conversationId: string,
  scope: MemoryScope = "conversation",
): MemoryRecord {
  const who = normalise(identity);
  const trimmed = content.trim().slice(0, MAX_MEMORY_CHARS);
  if (!trimmed) throw new Error("Memory content must not be empty.");
  if (!CONVERSATION_ID.test(conversationId)) throw new Error("Unknown conversation.");
  if (!ownedBy(conversationId, who)) {
    const taken = getDb().prepare("SELECT 1 FROM conversations WHERE id = ?").get(conversationId);
    if (taken) throw new Error("Unknown conversation.");
    claim(conversationId, who);
  }
  const db = getDb();
  const record: MemoryRecord = {
    id: randomUUID(),
    conversationId,
    scope,
    content: trimmed,
    createdAt: new Date().toISOString(),
  };
  db.prepare(
    "INSERT INTO memories (id, tenant_id, owner_id, conversation_id, scope, content, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).run(record.id, who.tenant, who.owner, record.conversationId, record.scope, record.content, record.createdAt);
  return record;
}

export function deleteMemory(identity: MemoryIdentity, id: string): boolean {
  const who = normalise(identity);
  const changes = getDb()
    .prepare("DELETE FROM memories WHERE id = ? AND tenant_id = ? AND owner_id = ?")
    .run(id, who.tenant, who.owner).changes;
  return Number(changes) > 0;
}

export function deleteMemoriesForConversation(identity: MemoryIdentity, conversationId: string): number {
  const who = normalise(identity);
  return Number(
    getDb()
      .prepare(
        "DELETE FROM memories WHERE conversation_id = ? AND tenant_id = ? AND owner_id = ? AND scope = 'conversation'",
      )
      .run(conversationId, who.tenant, who.owner).changes,
  );
}

// Facts rendered into the system prompt, newest last so older context sits high.
export function memoryContext(identity: MemoryIdentity, conversationId: string, limit = 20): string {
  const rows = listMemories(identity, { conversationId }).slice(0, limit);
  if (rows.length === 0) return "";
  return [
    "Persistent memory (from earlier turns in this conversation and durable agent facts):",
    ...rows.map((m) => `- [${m.scope}] ${m.content}`),
  ].join("\n");
}

// Per-request factory: the identity and conversationId are bound server-side so
// the model can only read and write memories inside this principal's data.
export function createMemoryTools(identity: MemoryIdentity, conversationId: string) {
  const who = normalise(identity);
  const rememberTool = tool({
    description:
      "Save a durable fact to memory. Use for stated preferences, decisions, project " +
      "context and corrections the user wants carried across turns.",
    inputSchema: z.object({
      content: z.string().describe("The fact to remember, one concise sentence"),
      scope: z
        .enum(["conversation", "agent"])
        .optional()
        .describe("conversation = this thread only (default); agent = durable across threads"),
    }),
    execute: async ({ content, scope }) => {
      const memory = addMemory(who, content, conversationId, scope ?? "conversation");
      return { saved: true, id: memory.id, scope: memory.scope };
    },
  });

  const recallTool = tool({
    description: "Search saved memories. Returns every stored fact that mentions a keyword.",
    inputSchema: z.object({
      keyword: z.string().describe("Word or phrase to search for; empty returns all memories"),
    }),
    execute: async ({ keyword }) => {
      const all = listMemories(who);
      const q = keyword.trim().toLowerCase();
      const matches = q
        ? all.filter((m) => m.content.toLowerCase().includes(q))
        : all.slice(0, 20);
      return {
        count: matches.length,
        memories: matches.map((m) => ({ scope: m.scope, content: m.content })),
      };
    },
  });

  return { remember: rememberTool, recall: recallTool };
}
