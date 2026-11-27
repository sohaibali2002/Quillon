"use client";

import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport, isToolUIPart, type FileUIPart } from "ai";
import { useEffect, useMemo, useRef, useState } from "react";
import type { ChatMessage, ChatTools } from "@/lib/ai-types";
import { MarkdownLite } from "./markdown-lite";
import { ToolPartView } from "./tool-cards";
import { BrandMark } from "./brand";

type ModelOption = { id: string; label: string };

const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;

// Upload once through /api/files and reference the returned id: the chat body
// stays small, and the route re-sends bytes only for the latest turn.
async function uploadFile(file: File): Promise<FileUIPart> {
  if (file.size > MAX_UPLOAD_BYTES) {
    throw new Error(`${file.name} is over the 20 MB limit.`);
  }
  const form = new FormData();
  form.append("file", file);
  const res = await fetch("/api/files", { method: "POST", body: form });
  const body = (await res.json().catch(() => ({}))) as {
    url?: string;
    file?: { mediaType?: string; filename?: string };
    error?: { message?: string };
  };
  if (!res.ok || !body.url) {
    throw new Error(body.error?.message ?? `Upload failed (${res.status}).`);
  }
  return {
    type: "file",
    mediaType: body.file?.mediaType || file.type || "application/octet-stream",
    filename: body.file?.filename ?? file.name,
    url: body.url,
  };
}

const starters = [
  { label: "Code", text: "Run a Python snippet that sums the numbers 1 to 10." },
  { label: "Search", text: "Search GitHub for open issues about rate limits." },
  { label: "Doc", text: "Create an Excel workbook of monthly revenue by region." },
];

const toolCopy: Record<string, string> = {
  runCode: "Executes a snippet in the sandbox",
  remember: "Saves a fact to agent memory",
  recall: "Searches saved memories",
};

type SkillOption = { id: string; name: string; description: string };

export default function Chat() {
  const [models, setModels] = useState<ModelOption[]>([]);
  const [model, setModel] = useState("");
  const [input, setInput] = useState("");
  const [files, setFiles] = useState<FileUIPart[]>([]);
  const [attachError, setAttachError] = useState("");
  const [elapsed, setElapsed] = useState<number | null>(null);
  const [ledger, setLedger] = useState<
    { id: string; round: number; ms: number; parts: number; toolCalls: number }[]
  >([]);
  const [skills, setSkills] = useState<SkillOption[]>([]);
  const [activeSkills, setActiveSkills] = useState<string[]>([]);
  const [compacted, setCompacted] = useState<number | null>(null);

  // One stable thread id per mount: scopes memory writes and compaction.
  const conversationId = useMemo(
    () =>
      typeof crypto !== "undefined" && "randomUUID" in crypto
        ? crypto.randomUUID()
        : `conv-${Date.now()}`,
    [],
  );

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const startedAt = useRef<number | null>(null);

  const { messages, sendMessage, status, error, stop, regenerate, setMessages, clearError } =
    useChat<ChatMessage>({
      transport: new DefaultChatTransport({ api: "/api/chat" }),
    });

  useEffect(() => {
    fetch("/api/config")
      .then((r) => {
        if (!r.ok) throw new Error();
        return r.json();
      })
      .then((c: { models: ModelOption[]; defaultModel: string }) => {
        setModels(c.models ?? []);
        setModel(c.defaultModel ?? "");
      })
      .catch(() => {});
    fetch("/api/skills")
      .then((r) => {
        if (!r.ok) throw new Error();
        return r.json();
      })
      .then((d: { skills: SkillOption[] }) => setSkills(d.skills ?? []))
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (status === "submitted" && startedAt.current === null) {
      startedAt.current = Date.now();
    }
    if ((status === "ready" || status === "error") && startedAt.current !== null) {
      const ms = Date.now() - startedAt.current;
      startedAt.current = null;
      setElapsed(ms);
      const lastAssistant = [...messages].reverse().find((m) => m.role === "assistant");
      if (lastAssistant) {
        let toolCalls = 0;
        for (const p of lastAssistant.parts) {
          if (isToolUIPart<ChatTools>(p)) toolCalls += 1;
        }
        setLedger((prev) => [
          ...prev.filter((e) => e.id !== lastAssistant.id),
          {
            id: lastAssistant.id,
            round: prev.length + 1,
            ms,
            parts: lastAssistant.parts.length,
            toolCalls,
          },
        ]);
      }
      // Refresh compaction status: older turns may have been folded just now.
      fetch(`/api/compaction?conversationId=${encodeURIComponent(conversationId)}`)
        .then((r) => r.json())
        .then((d: { compaction: { compactedCount: number } | null }) =>
          setCompacted(d.compaction?.compactedCount ?? 0),
        )
        .catch(() => {});
    }
  }, [status, messages]);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, status]);

  const busy = status === "submitted" || status === "streaming";

  const stats = useMemo(() => {
    let parts = 0;
    let toolParts = 0;
    let attachments = 0;
    for (const m of messages) {
      parts += m.parts.length;
      for (const p of m.parts) {
        if (isToolUIPart<ChatTools>(p)) toolParts += 1;
        if (p.type === "file") attachments += 1;
      }
    }
    return { parts, toolParts, attachments };
  }, [messages]);

  const canSend = !busy && (input.trim().length > 0 || files.length > 0);

  function submit() {
    if (!canSend) return;
    sendMessage(
      { text: input.trim(), files },
      { body: { model, conversationId, skills: activeSkills } },
    );
    setInput("");
    setFiles([]);
    inputRef.current?.focus({ preventScroll: true });
  }

  function useStarter(text: string) {
    setInput(text);
    inputRef.current?.focus({ preventScroll: true });
  }

  return (
    <section className="desk" aria-label="Conversation transcript">
      <header className="desk-head">
        <div className="desk-title">
          <h2>Transcript</h2>
          <p>Typed parts, streamed as they arrive</p>
        </div>
        <div className="desk-controls">
          <label className="sr-only" htmlFor="model">
            Model
          </label>
          <select
            id="model"
            className="model-select"
            value={model}
            onChange={(e) => setModel(e.target.value)}
          >
            {models.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => {
              clearError();
              setMessages([]);
              setElapsed(null);
              setLedger([]);
            }}
            disabled={messages.length === 0}
          >
            New session
          </button>
        </div>
      </header>

      <div className="chat-grid">
        <div className="chat-main">
          {(() => {
            const last = [...messages].reverse().find((m) => m.role === "assistant");
            const problems = last?.metadata?.mcpErrors ?? [];
            if (problems.length === 0) return null;
            return (
              <div className="notice-warn" role="status">
                Connector down this turn:{" "}
                {problems.map((p) => `${p.server} (${p.message})`).join("; ")}
              </div>
            );
          })()}
          <div className="chat-scroll" ref={scrollRef} tabIndex={0} aria-label="Messages">
            {messages.length === 0 ? (
              <div className="chat-empty">
                <BrandMark className="chat-empty-mark" />
                <h3>Ask, and watch the parts arrive.</h3>
                <p>
                  Text streams token by token, tool calls render as cards with their own
                  state, and attachments travel with the message. Start with one of these.
                </p>
                <div className="starter-row">
                  {starters.map((s) => (
                    <button
                      key={s.label}
                      type="button"
                      className="starter"
                      onClick={() => useStarter(s.text)}
                    >
                      <span>{s.label}</span>
                      {s.text}
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              <ol className="thread">
                {messages.map((m, index) => {
                  const last = index === messages.length - 1;
                  const streamingHere = last && m.role === "assistant" && status === "streaming";
                  return (
                    <li key={m.id} className="turn" data-role={m.role}>
                      <div className="turn-avatar" aria-hidden="true">
                        {m.role === "assistant" ? <BrandMark /> : <span>you</span>}
                      </div>
                      <div className="turn-body">
                        <div className="turn-meta">
                          <span>{m.role === "assistant" ? "Quillon" : "You"}</span>
                          {m.role === "assistant" &&
                            (() => {
                              const entry = ledger.find((e) => e.id === m.id);
                              return (
                                entry && (
                                  <span className="turn-annot">
                                    {entry.ms} ms · {entry.toolCalls}{" "}
                                    {entry.toolCalls === 1 ? "tool call" : "tool calls"}
                                  </span>
                                )
                              );
                            })()}
                          <span className="turn-parts">
                            {m.parts.length} {m.parts.length === 1 ? "part" : "parts"}
                          </span>
                        </div>
                        {m.parts.map((p, i) => {
                          if (p.type === "text") {
                            return (
                              <div key={i} className="turn-text">
                                <MarkdownLite text={p.text} />
                                {streamingHere && i === m.parts.length - 1 && (
                                  <span className="caret" aria-hidden="true" />
                                )}
                              </div>
                            );
                          }
                          if (p.type === "file") {
                            return (
                              <figure key={i} className="turn-file">
                                {p.mediaType.startsWith("image/") ? (
                                  <img src={p.url} alt={p.filename ?? "attachment"} />
                                ) : (
                                  <span className="turn-file-name">{p.filename ?? p.mediaType}</span>
                                )}
                              </figure>
                            );
                          }
                          if (isToolUIPart<ChatTools>(p)) {
                            return <ToolPartView key={i} part={p} />;
                          }
                          return null;
                        })}
                      </div>
                    </li>
                  );
                })}
                {status === "submitted" && (
                  <li className="turn" data-role="assistant">
                    <div className="turn-avatar" aria-hidden="true">
                      <BrandMark />
                    </div>
                    <div className="turn-body">
                      <div className="turn-meta">
                        <span>Quillon</span>
                        <span className="turn-parts">awaiting first token</span>
                      </div>
                      <div className="skeleton-lines" aria-label="Waiting for the model">
                        <span />
                        <span />
                        <span />
                      </div>
                    </div>
                  </li>
                )}
              </ol>
            )}
          </div>

          {error && (
            <div className="desk-error" role="alert">
              <div>
                <strong>This turn failed.</strong>
                <p>{error.message}</p>
              </div>
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => regenerate()}>
                Retry
              </button>
            </div>
          )}

          <form
            className="composer"
            onSubmit={(e) => {
              e.preventDefault();
              submit();
            }}
          >
            {attachError && (
              <p className="notice-warn" role="alert">
                {attachError}
              </p>
            )}
            {files.length > 0 && (
              <ul className="composer-files" aria-label="Selected attachments">
                {files.map((f) => (
                  <li key={f.filename ?? f.url}>
                    <span>{f.filename}</span>
                    <button
                      type="button"
                      aria-label={`Remove ${f.filename}`}
                      onClick={() => setFiles((fs) => fs.filter((x) => x !== f))}
                    >
                      ×
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <div className="composer-field">
              <textarea
                ref={inputRef}
                value={input}
                rows={2}
                aria-label="Message"
                placeholder="Ask the workbench — a question, a file, or a snippet to run"
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    submit();
                  }
                }}
              />
            </div>
            <div className="composer-bar">
              <label className="attach">
                <input
                  type="file"
                  multiple
                  onChange={async (e) => {
                    setAttachError("");
                    const results = await Promise.allSettled(
                      Array.from(e.target.files ?? [], uploadFile),
                    );
                    const uploaded = results.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
                    const failed = results.flatMap((r) =>
                      r.status === "rejected"
                        ? [r.reason instanceof Error ? r.reason.message : "Upload failed."]
                        : [],
                    );
                    if (uploaded.length > 0) setFiles((prev) => [...prev, ...uploaded]);
                    if (failed.length > 0) setAttachError(failed.join(" "));
                    e.target.value = "";
                  }}
                />
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M12 5v14M5 12h14" />
                </svg>
                Attach
              </label>
              <span className="composer-hint">
                {input.length > 0 ? `${input.length} chars · ` : ""}Enter to send · Shift+Enter
                for a new line
              </span>
              {busy ? (
                <button type="button" className="btn btn-ghost" onClick={() => stop()}>
                  Stop
                </button>
              ) : (
                <button type="submit" className="btn" disabled={!canSend}>
                  Send
                </button>
              )}
            </div>
          </form>
        </div>

        <aside className="chat-rail" aria-label="Session details">
          <div className="rail-block">
            <h3>Run ledger</h3>
            {ledger.length === 0 ? (
              <p className="ledger-empty">No rounds closed yet.</p>
            ) : (
              <table className="ledger">
                <thead>
                  <tr>
                    <th scope="col">Round</th>
                    <th scope="col">Latency</th>
                    <th scope="col">Parts</th>
                    <th scope="col">Tools</th>
                  </tr>
                </thead>
                <tbody>
                  {ledger.map((e) => (
                    <tr key={e.id}>
                      <td>{String(e.round).padStart(2, "0")}</td>
                      <td>{e.ms} ms</td>
                      <td>{e.parts}</td>
                      <td>{e.toolCalls}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          <div className="rail-block">
            <h3>Session</h3>
            <dl>
              <div>
                <dt>Status</dt>
                <dd>
                  <span className="chip" data-tone={busy ? "run" : "ok"}>
                    <span className="chip-dot" />
                    {status}
                  </span>
                </dd>
              </div>
              <div>
                <dt>Model</dt>
                <dd>{model || "—"}</dd>
              </div>
              <div>
                <dt>Turns</dt>
                <dd>
                  {messages.length} · {stats.parts} parts
                </dd>
              </div>
              <div>
                <dt>Tool calls</dt>
                <dd>{stats.toolParts}</dd>
              </div>
              <div>
                <dt>Attachments</dt>
                <dd>{stats.attachments + files.length}</dd>
              </div>
              <div>
                <dt>Compacted turns</dt>
                <dd>{compacted === null ? "—" : compacted}</dd>
              </div>
              <div>
                <dt>Last round</dt>
                <dd>{elapsed === null ? "—" : `${elapsed} ms`}</dd>
              </div>
            </dl>
          </div>

          <div className="rail-block">
            <h3>Tools on this desk</h3>
            <ul className="rail-tools">
              {Object.entries(toolCopy).map(([name, copy]) => (
                <li key={name}>
                  <code>{name}</code>
                  <span>{copy}</span>
                </li>
              ))}
            </ul>
          </div>

          <div className="rail-block">
            <h3>Skills on this desk</h3>
            {skills.length === 0 ? (
              <p className="ledger-empty">No skills installed.</p>
            ) : (
              <ul className="rail-tools">
                {skills.map((s) => {
                  const on = activeSkills.includes(s.id);
                  return (
                    <li key={s.id}>
                      <label className="rail-skill">
                        <input
                          type="checkbox"
                          checked={on}
                          onChange={() =>
                            setActiveSkills((prev) =>
                              on ? prev.filter((x) => x !== s.id) : [...prev, s.id],
                            )
                          }
                        />
                        <code>{s.name}</code>
                        <span>{s.description}</span>
                      </label>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>

          <div className="rail-block rail-note">
            <h3>Transport</h3>
            <p>
              <code>POST /api/chat</code> with <code>DefaultChatTransport</code>. Set a
              provider key and the desk streams live tokens.
            </p>
          </div>
        </aside>
      </div>
    </section>
  );
}
