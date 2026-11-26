"use client";

// Memory desk: every stored fact with its scope, plus manual add and delete.
// The same store powers the model's remember/recall tools in chat and agents.
import { useCallback, useEffect, useState } from "react";
import { Metric, Pill } from "./ui-bits";

type Memory = {
  id: string;
  conversationId: string;
  scope: "conversation" | "agent";
  content: string;
  createdAt: string;
};

export default function MemoryPanel() {
  const [memories, setMemories] = useState<Memory[] | null>(null);
  const [content, setContent] = useState("");
  const [scope, setScope] = useState<"conversation" | "agent">("agent");
  const [conversationId, setConversationId] = useState("default");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/memory");
      if (!res.ok) throw new Error();
      const data = (await res.json()) as { memories: Memory[] };
      setMemories(data.memories ?? []);
      setError(null);
    } catch {
      setError("Could not load memories.");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function add() {
    if (!content.trim()) return;
    setBusy(true);
    try {
      const res = await fetch("/api/memory", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content, scope, conversationId }),
      });
      if (!res.ok) {
        const data = (await res.json()) as { error?: { message?: string } };
        throw new Error(data.error?.message ?? "Save failed");
      }
      setContent("");
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Save failed.");
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string) {
    const before = memories;
    setMemories((prev) => prev?.filter((m) => m.id !== id) ?? null);
    try {
      const res = await fetch(`/api/memory?id=${encodeURIComponent(id)}`, { method: "DELETE" });
      if (!res.ok) {
        const data = (await res.json()) as { error?: { message?: string } };
        throw new Error(data.error?.message ?? "Delete failed");
      }
    } catch (e) {
      setMemories(before);
      setError(e instanceof Error ? e.message : "Delete failed.");
    } finally {
      await load();
    }
  }

  const agentCount = memories?.filter((m) => m.scope === "agent").length ?? 0;
  const convCount = memories?.filter((m) => m.scope === "conversation").length ?? 0;

  return (
    <section className="gp-section">
      <header className="gp-section-head">
        <div>
          <h2>Agent memory</h2>
          <p className="gp-fineprint">
            Facts persist in SQLite. The model writes them through the{" "}
            <code>remember</code> tool and reads them through <code>recall</code>;
            everything here is injected into its context each turn.
          </p>
        </div>
        <div className="gp-metrics">
          <Metric label="Agent facts" value={agentCount} hint="Durable across every conversation" />
          <Metric label="Conversation facts" value={convCount} hint="Scoped to one thread" />
        </div>
      </header>

      <div className="gp-form-row">
        <input
          className="gp-input"
          value={content}
          onChange={(e) => setContent(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) void add();
          }}
          placeholder="e.g. The user prefers TypeScript strict mode"
          aria-label="Memory content"
          maxLength={2000}
        />
        <select
          className="gp-input gp-select"
          value={scope}
          onChange={(e) => setScope(e.target.value as "conversation" | "agent")}
          aria-label="Memory scope"
        >
          <option value="agent">Agent (durable)</option>
          <option value="conversation">Conversation</option>
        </select>
        {scope === "conversation" && (
          <input
            className="gp-input"
            value={conversationId}
            onChange={(e) => setConversationId(e.target.value)}
            aria-label="Conversation id"
            maxLength={200}
            style={{ maxWidth: 180 }}
          />
        )}
        <button type="button" className="gp-btn" onClick={() => void add()} disabled={busy || !content.trim()}>
          {busy ? "Saving" : "Save memory"}
        </button>
      </div>
      {error && (
        <p role="alert" className="gp-error">
          {error}
        </p>
      )}

      {memories === null ? (
        <p className="gp-fineprint">Loading memories…</p>
      ) : memories.length === 0 ? (
        <p className="gp-fineprint">
          Nothing stored yet. Ask the model something like “remember that I deploy on
          Fridays” in the conversation desk and it appears here.
        </p>
      ) : (
        <ul className="gp-list">
          {memories.map((m) => (
            <li key={m.id} className="gp-list-row">
              <div className="gp-list-main">
                <span className="gp-list-text">{m.content}</span>
                <span className="gp-fineprint">
                  {m.scope === "agent" ? "agent · every conversation" : `conversation · ${m.conversationId}`}{" "}
                  · {new Date(m.createdAt).toLocaleString()}
                </span>
              </div>
              <Pill tone={m.scope === "agent" ? "run" : "idle"}>{m.scope}</Pill>
              <button type="button" className="gp-ghost" onClick={() => void remove(m.id)}>
                Delete
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
