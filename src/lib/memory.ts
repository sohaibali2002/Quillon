// Agent memory: facts persisted to sqlite and recalled into the model context.
// Two scopes: "conversation" (one thread) and "agent" (durable across threads).
// The model writes memories itself through the remember/recall tools.
import { randomUUID } from "node:crypto";
import { tool } from "ai";
import { z } from "zod";
import { getDb } from "@/lib/db";

export type MemoryScope = "conversation" | "agent";

export type MemoryRecord = {
  id: string;
  conversationId: string;
  scope: MemoryScope;
  content: string;
  createdAt: string;
};

export const MAX_MEMORY_CHARS = 2000;
export const MAX_MEMORIES = 200;

export function listMemories(conversationId?: string, scope?: MemoryScope): MemoryRecord[] {
  const db = getDb();
  const where: string[] = [];
  const params: (string | null)[] = [];
  if (conversationId) {
    where.push("(conversation_id = ? OR scope = 'agent')");
    params.push(conversationId);
  }
  if (scope) {
    where.push("scope = ?");
    params.push(scope);
  }
  const sql = `SELECT id, conversation_id, scope, content, created_at FROM memories
    ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
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
  content: string,
  conversationId: string,
  scope: MemoryScope = "conversation",
): MemoryRecord {
  const trimmed = content.trim().slice(0, MAX_MEMORY_CHARS);
  if (!trimmed) throw new Error("Memory content must not be empty.");
  const db = getDb();
  const record: MemoryRecord = {
    id: randomUUID(),
    conversationId,
    scope,
    content: trimmed,
    createdAt: new Date().toISOString(),
  };
  db.prepare(
    "INSERT INTO memories (id, conversation_id, scope, content, created_at) VALUES (?, ?, ?, ?, ?)",
  ).run(record.id, record.conversationId, record.scope, record.content, record.createdAt);
  return record;
}

export function deleteMemory(id: string): boolean {
  const db = getDb();
  const changes = db.prepare("DELETE FROM memories WHERE id = ?").run(id).changes;
  return Number(changes) > 0;
}

export function deleteMemoriesForConversation(conversationId: string): number {
  return Number(
    getDb()
      .prepare("DELETE FROM memories WHERE conversation_id = ? AND scope = 'conversation'")
      .run(conversationId).changes,
  );
}

// Facts rendered into the system prompt, newest last so older context sits high.
export function memoryContext(conversationId: string, limit = 20): string {
  const rows = listMemories(conversationId).slice(0, limit);
  if (rows.length === 0) return "";
  return [
    "Persistent memory (from earlier turns in this conversation and durable agent facts):",
    ...rows.map((m) => `- [${m.scope}] ${m.content}`),
  ].join("\n");
}

// Per-request factory: the conversationId is bound server-side so the model
// can only write memories into the thread it is answering in.
export function createMemoryTools(conversationId: string) {
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
      const memory = addMemory(content, conversationId, scope ?? "conversation");
      return { saved: true, id: memory.id, scope: memory.scope };
    },
  });

  const recallTool = tool({
    description: "Search saved memories. Returns every stored fact that mentions a keyword.",
    inputSchema: z.object({
      keyword: z.string().describe("Word or phrase to search for; empty returns all memories"),
    }),
    execute: async ({ keyword }) => {
      const all = listMemories();
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
