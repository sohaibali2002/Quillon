// Automatic context compaction: when an incoming thread outgrows the token
// window budget, older turns are folded into a stored summary so the model
// keeps long-term context while recent turns stay verbatim.
import { generateText, type UIMessage } from "ai";
import { getDb } from "@/lib/db";
import { resolveModelAny } from "@/lib/models";

// Conservative estimate: ~4 characters per token for prose and code.
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export const COMPACT_THRESHOLD_TOKENS = 1200;
export const KEEP_RECENT_MESSAGES = 6;

export type CompactionResult = {
  compacted: boolean;
  summary: string;
  compactedCount: number;
  tokenEstimate: number;
};

export function messageText(messages: UIMessage[]): string {
  return messages
    .map((m) => {
      const body = m.parts
        .map((p) => {
          if (p.type === "text") return p.text;
          if (p.type.startsWith("tool-")) return `[tool ${p.type.slice(5)}]`;
          return "";
        })
        .filter(Boolean)
        .join(" ");
      return `${m.role}: ${body}`;
    })
    .join("\n");
}

type CompactionRow = {
  summary: string;
  compacted_count: number;
  token_estimate: number;
};

export function loadCompaction(conversationId: string): CompactionResult | null {
  const row = getDb()
    .prepare(
      "SELECT summary, compacted_count, token_estimate FROM compactions WHERE conversation_id = ?",
    )
    .get(conversationId) as CompactionRow | undefined;
  if (!row) return null;
  return {
    compacted: true,
    summary: row.summary,
    compactedCount: row.compacted_count,
    tokenEstimate: row.token_estimate,
  };
}

function saveCompaction(
  conversationId: string,
  summary: string,
  compactedCount: number,
  tokenEstimate: number,
): CompactionResult {
  getDb()
    .prepare(
      `INSERT INTO compactions (conversation_id, summary, compacted_count, token_estimate, updated_at)
       VALUES (?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
       ON CONFLICT(conversation_id) DO UPDATE SET
         summary = excluded.summary,
         compacted_count = excluded.compacted_count,
         token_estimate = excluded.token_estimate,
         updated_at = excluded.updated_at`,
    )
    .run(conversationId, summary, compactedCount, tokenEstimate);
  return { compacted: true, summary, compactedCount, tokenEstimate };
}

// Summarize older turns and persist the rolling summary. Returns which
// messages to send to the model: either all of them (nothing compacted) or
// the kept recent ones (the summary travels in the system prompt instead).
export async function compactIfNeeded(
  conversationId: string,
  messages: UIMessage[],
  model?: string,
): Promise<{ result: CompactionResult | null; keptMessages: UIMessage[] }> {
  const existing = loadCompaction(conversationId);
  const tokens = estimateTokens(messageText(messages));

  if (messages.length <= KEEP_RECENT_MESSAGES || tokens < COMPACT_THRESHOLD_TOKENS) {
    return { result: existing, keptMessages: messages };
  }

  const older = messages.slice(0, messages.length - KEEP_RECENT_MESSAGES);
  const keptMessages = messages.slice(messages.length - KEEP_RECENT_MESSAGES);

  let newSummary = "";
  try {
    const result = await generateText({
      model: await resolveModelAny(model),
      prompt:
        "Compress this conversation excerpt into a durable summary. Keep decisions, " +
        "facts, names, numbers and open questions. Reply with the summary only.\n\n" +
        messageText(older),
    });
    newSummary = result.text.trim();
  } catch {
    // Compaction must never break the chat turn; keep prior summary instead.
    return { result: existing, keptMessages: messages };
  }
  if (!newSummary) {
    return { result: existing, keptMessages: messages };
  }

  const merged = [existing?.summary, newSummary].filter(Boolean).join("\n\n");
  const priorCount = existing?.compactedCount ?? 0;
  const compacted = saveCompaction(
    conversationId,
    merged,
    priorCount + older.length,
    estimateTokens(merged),
  );
  return { result: compacted, keptMessages };
}

export function compactionContext(result: CompactionResult | null): string {
  if (!result || !result.summary) return "";
  return [
    `Summary of ${result.compactedCount} earlier turn(s), kept from automatic context compaction:`,
    result.summary,
  ].join("\n");
}
