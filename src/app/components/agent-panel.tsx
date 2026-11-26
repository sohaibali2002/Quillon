"use client";

import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport, isToolUIPart } from "ai";
import { useState } from "react";
import type { ChatMessage, ChatTools } from "@/lib/ai-types";
import { MarkdownLite } from "./markdown-lite";
import { ToolPartView } from "./tool-cards";

type AgentResult = {
  output?: { summary: string; toolsUsed: string[]; confidence: number };
  steps: number;
  usage: { inputTokens: number; outputTokens: number; totalTokens: number };
};

export default function AgentPanel() {
  const [prompt, setPrompt] = useState(
    "What is the weather in San Francisco? Convert it to Celsius for me.",
  );
  const [mode, setMode] = useState<"text" | "structured">("text");
  const [result, setResult] = useState<AgentResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { messages, sendMessage, status, error: streamError } =
    useChat<ChatMessage>({
      transport: new DefaultChatTransport({ api: "/api/agent" }),
    });

  async function runStructured() {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const r = await fetch("/api/agent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt, mode }),
      });
      if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
      setResult(await r.json());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  function run() {
    if (mode === "structured") return runStructured();
    setError(null);
    sendMessage({ text: prompt });
  }

  const running = busy || status === "streaming" || status === "submitted";
  const shownError = error ?? streamError?.message;

  return (
    <section className="card" aria-label="Agent">
      <h2>Agent loop (ToolLoopAgent, stopWhen: stepCountIs(8))</h2>
      <textarea rows={2} value={prompt} onChange={(e) => setPrompt(e.target.value)} aria-label="Agent prompt" />
      <div className="row" style={{ marginTop: 8 }}>
        <select value={mode} onChange={(e) => setMode(e.target.value as "text" | "structured")} aria-label="Agent mode">
          <option value="text">Text + tools (streamed)</option>
          <option value="structured">Structured summary</option>
        </select>
        <button onClick={run} disabled={running}>
          {running ? "Running…" : "Run agent"}
        </button>
      </div>
      {shownError && <p style={{ color: "salmon" }}>Error: {shownError}</p>}
      {mode === "text" ? (
        messages.map((m) => (
          <div key={m.id} className={`msg ${m.role}`}>
            <div className="role">{m.role}</div>
            {m.parts.map((p, i) => {
              if (p.type === "text") return <MarkdownLite key={i} text={p.text} />;
              if (isToolUIPart<ChatTools>(p))
                return <ToolPartView key={i} part={p} />;
              return null;
            })}
          </div>
        ))
      ) : result ? (
        <div className="out">
          <strong>{result.output?.summary}</strong>
          {result.output?.toolsUsed ? (
            <>
              {"\n"}
              {result.output.toolsUsed.join(", ")}
            </>
          ) : null}
          {typeof result.output?.confidence === "number" && (
            <>
              {"\n"}
              confidence: {Math.round(result.output.confidence * 100)}%
            </>
          )}
          {"\n"}
          {result.steps} steps · {result.usage?.totalTokens ?? "-"} tokens
        </div>
      ) : null}
    </section>
  );
}
