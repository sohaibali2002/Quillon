// Shared client-side UI types derived from the server tool definitions.
import type { InferUITools } from "ai";
import type { UIMessage } from "ai";
import type { platformTools } from "@/lib/tools";

export type ChatTools = InferUITools<typeof platformTools>;

// Per-answer metadata streamed by /api/chat on the start and finish parts.
export type AnswerMetadata = {
  model: string | null;
  startedAt: number;
  ms?: number;
  inputTokens?: number | null;
  outputTokens?: number | null;
  finishReason?: string;
  compacted?: number;
};

export type ChatMessage = UIMessage<AnswerMetadata, never, ChatTools>;
