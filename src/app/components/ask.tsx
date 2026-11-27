"use client";

import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport, isToolUIPart, type FileUIPart } from "ai";
import { useEffect, useMemo, useRef, useState } from "react";
import type { ChatMessage, ChatTools } from "@/lib/ai-types";
import { MarkdownLite } from "./markdown-lite";
import { ToolPartView } from "./tool-cards";
import CopyButton from "./copy-button";
import ModeBadge from "./mode-badge";

type ModelOption = { id: string; label: string };
type SkillOption = { id: string; name: string; description: string };

function toFileUIPart(file: File): Promise<FileUIPart> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) =>
      resolve({
        type: "file",
        mediaType: file.type || "application/octet-stream",
        filename: file.name,
        url: e.target?.result as string,
      });
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

const starters = [
  {
    title: "Brief a long document",
    detail: "Surface decisions, risks, and open questions.",
    prompt: "I’m going to attach a report. Summarize it in five executive bullets, then identify the key risks and open questions.",
    icon: "M6 3.75h8l4 4V20.25H6zM14 3.75v4h4M9 12h6M9 15.5h6",
  },
  {
    title: "Analyze a dataset",
    detail: "Find patterns in a CSV or spreadsheet.",
    prompt: "I’m going to attach a dataset. Inspect its structure, identify the most important patterns, and explain any caveats.",
    icon: "M4 19.5h16M6.5 16v-4M11.5 16V7M16.5 16v-6",
  },
  {
    title: "Run a calculation",
    detail: "Work through the numbers with Python.",
    prompt: "Use Python to calculate the compound annual growth rate for an investment that grows from $25,000 to $41,000 over 6 years, and show the formula.",
    icon: "M8 4.5h8M8 9h8M8 13.5h3M15.5 13l3 3m0-3-3 3M6 2.75h12a2 2 0 0 1 2 2v14.5a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4.75a2 2 0 0 1 2-2z",
  },
  {
    title: "Draft a briefing",
    detail: "Turn a rough idea into a clear first draft.",
    prompt: "Draft a concise executive briefing on the trade-offs of running AI models locally versus through a hosted provider. Organize it into recommendation, rationale, and risks.",
    icon: "M5 4.5h14v15H5zM8 8h8M8 11.5h8M8 15h5",
  },
];

const toolNames: Record<string, string> = {
  weather: "Weather lookup",
  convertTemperature: "Temperature conversion",
  getTime: "World clock",
  runCode: "Sandbox run",
  remember: "Saved to memory",
  recall: "Memory search",
};

function toolLabel(type: string, toolName?: string) {
  const name = toolName ?? type.replace(/^tool-/, "");
  return toolNames[name] ?? name.replace(/^mcp_/, "MCP · ").replace(/_/g, " ");
}

function hostOf(url: string) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

type Turn = { id: string; question: ChatMessage; answer: ChatMessage | null };

function groupTurns(messages: ChatMessage[]): Turn[] {
  const turns: Turn[] = [];
  for (const m of messages) {
    if (m.role === "user") turns.push({ id: m.id, question: m, answer: null });
    else if (m.role === "assistant" && turns.length > 0) turns[turns.length - 1].answer = m;
  }
  return turns;
}

function questionText(m: ChatMessage) {
  return m.parts
    .map((p) => (p.type === "text" ? p.text : ""))
    .join(" ")
    .trim();
}

function ChatHeader({ hasConversation }: { hasConversation: boolean }) {
  return (
    <header className="lg-topbar">
      <p className="lg-page-path">
        <span>Workspace</span>
        <span className="lg-path-divider" aria-hidden="true">/</span>
        <strong>Assistant</strong>
      </p>
      <div className="lg-topbar-actions">
        <ModeBadge />
        {hasConversation && (
          <button
            type="button"
            className="lg-new-session"
            aria-label="New conversation"
            onClick={() => window.dispatchEvent(new Event("quillon:new-thread"))}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
              <path d="M12 5v14M5 12h14" />
            </svg>
            <span>New conversation</span>
          </button>
        )}
      </div>
    </header>
  );
}

export default function Ask() {
  const [models, setModels] = useState<ModelOption[]>([]);
  const [model, setModel] = useState("");
  const [input, setInput] = useState("");
  const [files, setFiles] = useState<FileUIPart[]>([]);
  const [skills, setSkills] = useState<SkillOption[]>([]);
  const [activeSkills, setActiveSkills] = useState<string[]>([]);
  const [ready, setReady] = useState(false);

  const conversationId = useMemo(
    () =>
      typeof crypto !== "undefined" && "randomUUID" in crypto
        ? crypto.randomUUID()
        : `conv-${Date.now()}`,
    [],
  );

  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const endRef = useRef<HTMLDivElement | null>(null);

  const transport = useMemo(() => new DefaultChatTransport({ api: "/api/chat" }), []);
  const { messages, sendMessage, status, error, stop, regenerate, setMessages, clearError } =
    useChat<ChatMessage>({ transport });

  useEffect(() => {
    setReady(true);
    fetch("/api/config")
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((c: { models: ModelOption[]; defaultModel: string }) => {
        setModels(c.models ?? []);
        setModel(c.defaultModel ?? "");
      })
      .catch(() => {});
    fetch("/api/skills")
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((d: { skills: SkillOption[] }) => setSkills(d.skills ?? []))
      .catch(() => {});
  }, []);

  useEffect(() => {
    const onNew = () => {
      clearError();
      setMessages([]);
      setInput("");
      setFiles([]);
      inputRef.current?.focus({ preventScroll: true });
    };
    window.addEventListener("quillon:new-thread", onNew);
    return () => window.removeEventListener("quillon:new-thread", onNew);
  }, [clearError, setMessages]);

  useEffect(() => {
    if (messages.length > 0) endRef.current?.scrollIntoView({ block: "end", behavior: "smooth" });
  }, [messages.length, status]);

  const busy = status === "submitted" || status === "streaming";
  const canSend = ready && !busy && (input.trim().length > 0 || files.length > 0);
  const turns = useMemo(() => groupTurns(messages), [messages]);
  const empty = turns.length === 0;

  function submit() {
    if (!canSend) return;
    sendMessage(
      { text: input.trim(), files },
      { body: { model, conversationId, skills: activeSkills } },
    );
    setInput("");
    setFiles([]);
  }

  const composer = (
    <form
      className={`lg-composer ${empty ? "lg-composer-hero" : "lg-composer-dock"}`}
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      {files.length > 0 && (
        <ul className="lg-files" aria-label="Selected attachments">
          {files.map((f) => (
            <li key={f.filename ?? f.url}>
              <span>{f.filename}</span>
              <button
                type="button"
                aria-label={`Remove ${f.filename}`}
                onClick={() => setFiles((fs) => fs.filter((x) => x !== f))}
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
                  <path d="M6 6l12 12M18 6L6 18" />
                </svg>
              </button>
            </li>
          ))}
        </ul>
      )}
      <textarea
        ref={inputRef}
        value={input}
        rows={empty ? 3 : 1}
        aria-label="Ask Quillon"
        placeholder={empty ? "Ask anything, attach a file, or paste code to run" : "Ask a follow-up"}
        onChange={(e) => setInput(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            if (e.nativeEvent.isComposing || e.keyCode === 229) return;
            e.preventDefault();
            submit();
          }
        }}
      />
      <div className="lg-bar">
        <label className="lg-icon-btn" title="Attach files">
          <input
            type="file"
            multiple
            className="sr-only"
            onChange={async (e) => {
              const picked = await Promise.all(Array.from(e.target.files ?? [], toFileUIPart));
              setFiles((prev) => [...prev, ...picked]);
              e.target.value = "";
            }}
          />
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M20 11.5l-8.2 8.2a5 5 0 0 1-7.1-7.1l8.5-8.5a3.3 3.3 0 0 1 4.7 4.7l-8.5 8.5a1.7 1.7 0 0 1-2.4-2.4l7.8-7.8" />
          </svg>
          <span className="sr-only">Attach files</span>
        </label>
        <label className="sr-only" htmlFor="lg-model">
          Model
        </label>
        <select
          id="lg-model"
          className="lg-select"
          value={model}
          onChange={(e) => setModel(e.target.value)}
          disabled={models.length === 0}
        >
          {models.length === 0 && <option value="">Loading models</option>}
          {models.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label}
            </option>
          ))}
        </select>
        <span className="lg-bar-spacer" />
        {busy ? (
          <button type="button" className="lg-send lg-stop" onClick={() => stop()}>
            Stop
          </button>
        ) : (
          <button type="submit" className="lg-send" disabled={!canSend} aria-label="Ask Quillon">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M12 19V5M5 12l7-7 7 7" />
            </svg>
          </button>
        )}
      </div>
      {skills.length > 0 && (
        <div className="lg-skills" role="group" aria-label="Skills for this question">
          {skills.map((s) => {
            const on = activeSkills.includes(s.id);
            return (
              <button
                key={s.id}
                type="button"
                className="lg-skill"
                aria-pressed={on}
                title={s.description}
                onClick={() =>
                  setActiveSkills((prev) => (on ? prev.filter((x) => x !== s.id) : [...prev, s.id]))
                }
              >
                {s.name}
              </button>
            );
          })}
        </div>
      )}
    </form>
  );

  if (empty) {
    return (
      <div className="lg-workspace">
        <ChatHeader hasConversation={false} />
        <section className="lg-home" aria-labelledby="lg-home-title">
          <div className="lg-home-copy">
            <p className="lg-eyebrow">
              <span className="lg-eyebrow-dot" aria-hidden="true" />
              New conversation <span className="lg-eyebrow-divider">/</span> Quillon assistant
            </p>
            <h1 id="lg-home-title" className="lg-title">What would you like to work through?</h1>
            <p className="lg-lede">
              Bring a document, explore an idea, or ask for help with a task. Keep your model,
              tools, and context together in one focused workspace.
            </p>
          </div>
          {composer}
          <section className="lg-suggestion-section" aria-labelledby="lg-suggestion-title">
            <div className="lg-suggestion-heading">
              <h2 id="lg-suggestion-title">Start with a task</h2>
              <p>Choose a prompt or write your own.</p>
            </div>
            <ul className="lg-starters" aria-label="Suggested tasks">
              {starters.map((starter) => (
                <li key={starter.title}>
                  <button
                    type="button"
                    aria-label={`Start: ${starter.title}`}
                    onClick={() => {
                      setInput(starter.prompt);
                      inputRef.current?.focus({ preventScroll: true });
                    }}
                  >
                    <span className="lg-starter-icon" aria-hidden="true">
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round">
                        <path d={starter.icon} />
                      </svg>
                    </span>
                    <span className="lg-starter-copy">
                      <strong>{starter.title}</strong>
                      <span>{starter.detail}</span>
                    </span>
                    <svg className="lg-starter-arrow" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <path d="M5 12h14M13 6l6 6-6 6" />
                    </svg>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        </section>
      </div>
    );
  }

  return (
    <div className="lg-workspace">
      <ChatHeader hasConversation />
      <div className="lg-thread">
      {turns.map((t, index) => {
        const last = index === turns.length - 1;
        const answer = t.answer;
        const parts = answer?.parts ?? [];
        const text = parts
          .map((p) => (p.type === "text" ? p.text : ""))
          .join("\n\n")
          .trim();
        const tools = parts.filter((p) => isToolUIPart<ChatTools>(p));
        const sources = parts.filter((p) => p.type === "source-url");
        const meta = answer?.metadata;
        const pending = last && (status === "submitted" || (status === "streaming" && !answer));
        const streaming = last && status === "streaming";
        const attachments = t.question.parts.filter((p) => p.type === "file");

        return (
          <article key={t.id} className="lg-turn" aria-label={`Answer ${index + 1}`}>
            <header className="lg-q">
              <h2>{questionText(t.question) || "Attached files"}</h2>
              {attachments.length > 0 && (
                <ul className="lg-q-files">
                  {attachments.map((f, i) =>
                    f.type === "file" ? (
                      <li key={i}>
                        {f.mediaType.startsWith("image/") ? (
                          <img src={f.url} alt={f.filename ?? "Attached image"} />
                        ) : (
                          <span>{f.filename ?? f.mediaType}</span>
                        )}
                      </li>
                    ) : null,
                  )}
                </ul>
              )}
            </header>

            <div className="lg-answer-grid">
              <div className="lg-answer">
                <h3 className="lg-label">
                  <span className={`lg-dot ${streaming ? "lg-dot-live" : ""}`} aria-hidden="true" />
                  Answer
                </h3>
                {pending && !text ? (
                  <div className="lg-skeleton" aria-label="Waiting for the first token">
                    <span />
                    <span />
                    <span />
                  </div>
                ) : (
                  parts.map((p, i) => {
                    if (p.type === "text") {
                      return (
                        <div key={i} className="lg-prose">
                          <MarkdownLite text={p.text} />
                          {streaming && i === parts.length - 1 && <span className="caret" aria-hidden="true" />}
                        </div>
                      );
                    }
                    if (isToolUIPart<ChatTools>(p)) return <ToolPartView key={i} part={p} />;
                    return null;
                  })
                )}
                {answer && !streaming && (
                  <footer className="lg-actions">
                    {text && <CopyButton value={text} label="Copy answer" />}
                    {last && (
                      <button type="button" className="btn btn-quiet btn-sm" onClick={() => regenerate()}>
                        Rewrite
                      </button>
                    )}
                    {meta?.ms !== undefined && (
                      <span className="lg-meta">
                        {(meta.ms / 1000).toFixed(1)} s
                        {meta.outputTokens != null ? ` · ${meta.outputTokens} tokens out` : ""}
                      </span>
                    )}
                  </footer>
                )}
              </div>

              <aside className="lg-side" aria-label="How this answer was made">
                <details open>
                  <summary>
                    Sources <span className="lg-count">{sources.length}</span>
                  </summary>
                  {sources.length === 0 ? (
                    <p className="lg-side-empty">
                      {pending || streaming
                        ? "Collecting citations…"
                        : "No web sources. Answered from the model and its tools."}
                    </p>
                  ) : (
                    <ol className="lg-sources">
                      {sources.map((s, i) =>
                        s.type === "source-url" ? (
                          <li key={s.sourceId}>
                            <a href={s.url} target="_blank" rel="noreferrer">
                              <span className="lg-src-n">{i + 1}</span>
                              <span className="lg-src-body">
                                <b>{s.title ?? hostOf(s.url)}</b>
                                <small>{hostOf(s.url)}</small>
                              </span>
                            </a>
                          </li>
                        ) : null,
                      )}
                    </ol>
                  )}
                </details>
                <details open>
                  <summary>
                    Steps <span className="lg-count">{tools.length}</span>
                  </summary>
                  {tools.length === 0 ? (
                    <p className="lg-side-empty">{pending || streaming ? "Thinking…" : "No tools were needed."}</p>
                  ) : (
                    <ol className="lg-steps">
                      {tools.map((p, i) =>
                        isToolUIPart<ChatTools>(p) ? (
                          <li key={i} data-state={p.state}>
                            <span className="lg-step-dot" aria-hidden="true" />
                            <span>{toolLabel(p.type, "toolName" in p ? (p.toolName as string) : undefined)}</span>
                            <small>
                              {p.state === "output-available"
                                ? "done"
                                : p.state === "output-error"
                                  ? "failed"
                                  : "running"}
                            </small>
                          </li>
                        ) : null,
                      )}
                    </ol>
                  )}
                </details>
                {meta && (
                  <details>
                    <summary>Run details</summary>
                    <dl className="lg-dl">
                      <div>
                        <dt>Model</dt>
                        <dd>{meta.model ?? model ?? "—"}</dd>
                      </div>
                      <div>
                        <dt>Time</dt>
                        <dd>{meta.ms !== undefined ? `${meta.ms} ms` : "streaming"}</dd>
                      </div>
                      <div>
                        <dt>Tokens in / out</dt>
                        <dd>
                          {meta.inputTokens ?? "—"} / {meta.outputTokens ?? "—"}
                        </dd>
                      </div>
                      <div>
                        <dt>Finish</dt>
                        <dd>{meta.finishReason ?? "—"}</dd>
                      </div>
                      <div>
                        <dt>Compacted turns</dt>
                        <dd>{meta.compacted ?? 0}</dd>
                      </div>
                    </dl>
                  </details>
                )}
              </aside>
            </div>
          </article>
        );
      })}

      {error && (
        <div className="lg-error" role="alert">
          <div>
            <strong>That answer did not finish.</strong>
            <p>{error.message}</p>
          </div>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => regenerate()}>
            Try again
          </button>
        </div>
      )}

      <div ref={endRef} />
      <div className="lg-dock">{composer}</div>
      </div>
    </div>
  );
}
