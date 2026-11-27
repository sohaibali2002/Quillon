"use client";

import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport, isToolUIPart, type FileUIPart } from "ai";
import useSWR from "swr";
import { useEffect, useMemo, useRef, useState, type ChangeEvent } from "react";
import type { ChatMessage, ChatTools } from "@/lib/ai-types";
import { MarkdownLite } from "./markdown-lite";
import { ToolPartView } from "./tool-cards";
import CopyButton from "./copy-button";
import { BrandMark } from "./brand";
import ModeBadge from "./mode-badge";

type ModelOption = {
  id: string;
  label: string;
  provider: string;
  providerLabel: string;
  freeTier: boolean;
};
type ProviderStatus = { id: string; label: string; available: boolean; freeTier: boolean };
type SkillOption = { id: string; name: string; description: string };
type WorkspaceConfig = {
  defaultModel: string;
  models: ModelOption[];
  modelErrors: string[];
  providers: ProviderStatus[];
};
type SkillsResponse = { skills: SkillOption[] };

type Turn = { id: string; question: ChatMessage; answer: ChatMessage | null };

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Request failed (${response.status}).`);
  return response.json() as Promise<T>;
}

function createConversationId() {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `conv-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function toFileUIPart(file: File): Promise<FileUIPart> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (event) =>
      resolve({
        type: "file",
        mediaType: file.type || "application/octet-stream",
        filename: file.name,
        url: event.target?.result as string,
      });
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

const starters = [
  {
    title: "Make sense of a file",
    detail: "Pull the key points out of a report or brief.",
    prompt: "I’m attaching a report. Summarize the key decisions, risks, and open questions.",
    icon: "M6 3.75h8l4 4V20.25H6zM14 3.75v4h4M9 12h6M9 15.5h6",
  },
  {
    title: "Explore a dataset",
    detail: "Find patterns and explain what stands out.",
    prompt: "I’m attaching a dataset. Inspect its structure, find the most important patterns, and explain any caveats.",
    icon: "M4 19.5h16M6.5 16v-4M11.5 16V7M16.5 16v-6",
  },
  {
    title: "Work through the numbers",
    detail: "Use Python for a transparent calculation.",
    prompt: "Use Python to calculate the compound annual growth rate for an investment that grows from $25,000 to $41,000 over 6 years, and show the formula.",
    icon: "M8 4.5h8M8 9h8M8 13.5h3M15.5 13l3 3m0-3-3 3M6 2.75h12a2 2 0 0 1 2 2v14.5a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4.75a2 2 0 0 1 2-2z",
  },
  {
    title: "Draft a clear response",
    detail: "Turn a rough idea into a polished first pass.",
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

function groupTurns(messages: ChatMessage[]): Turn[] {
  const turns: Turn[] = [];
  for (const message of messages) {
    if (message.role === "user") turns.push({ id: message.id, question: message, answer: null });
    else if (message.role === "assistant" && turns.length > 0) turns[turns.length - 1].answer = message;
  }
  return turns;
}

function questionText(message: ChatMessage) {
  return message.parts
    .map((part) => (part.type === "text" ? part.text : ""))
    .join(" ")
    .trim();
}

function ChatHeader({
  hasConversation,
  model,
  models,
  providers,
  loading,
  configError,
  modelErrors,
  onModelChange,
}: {
  hasConversation: boolean;
  model: string;
  models: ModelOption[];
  providers: ProviderStatus[];
  loading: boolean;
  configError?: Error;
  modelErrors: string[];
  onModelChange: (value: string) => void;
}) {
  const groups = [...new Set(models.map((option) => option.providerLabel))];

  return (
    <header className="chat-topbar">
      <div className="chat-topbar-inner">
        <div className="chat-topbar-brand">
          <BrandMark />
          <div>
            <p className="chat-topbar-kicker">QUILLON / WORKSPACE</p>
            <h1>Assistant</h1>
          </div>
        </div>
        <div className="chat-controls">
          <div className="chat-model-control">
            <label htmlFor="chat-model">Model</label>
            <select
              id="chat-model"
              value={model}
              onChange={(event) => onModelChange(event.target.value)}
              disabled={models.length === 0}
            >
              {models.length === 0 && <option value="">No models available</option>}
              {groups.map((group) => (
                <optgroup key={group} label={group}>
                  {models.filter((option) => option.providerLabel === group).map((option) => (
                    <option key={option.id} value={option.id}>{option.label}</option>
                  ))}
                </optgroup>
              ))}
            </select>
          </div>
          <ModeBadge
            models={models}
            providers={providers}
            loading={loading}
            error={configError}
            modelErrors={modelErrors}
          />
          {hasConversation && (
            <button
              type="button"
              className="chat-new-session"
              onClick={() => window.dispatchEvent(new Event("quillon:new-thread"))}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
                <path d="M12 5v14M5 12h14" />
              </svg>
              <span>New chat</span>
            </button>
          )}
        </div>
      </div>
    </header>
  );
}

function ProviderNotice({
  loading,
  error,
  modelErrors,
  onRetry,
}: {
  loading: boolean;
  error?: Error;
  modelErrors: string[];
  onRetry: () => void;
}) {
  if (loading) {
    return <p className="chat-provider-note" role="status">Checking connected model providers…</p>;
  }

  if (!error && modelErrors.length === 0) {
    return (
      <div className="chat-provider-notice" role="status">
        <span className="chat-provider-mark" aria-hidden="true">!</span>
        <div>
          <strong>No chat models are available yet</strong>
          <p>No provider keys are available in this environment. If your existing keys are Production-only, enable them for Preview or Development in Vercel Settings → Vars, then retry.</p>
        </div>
        <button type="button" onClick={onRetry}>Retry</button>
      </div>
    );
  }

  return (
    <div className="chat-provider-notice" role="alert">
      <span className="chat-provider-mark" aria-hidden="true">!</span>
      <div>
        <strong>Couldn&apos;t load the model catalog</strong>
        <p>{error?.message ?? modelErrors.join(" ")}</p>
      </div>
      <button type="button" onClick={onRetry}>Retry</button>
    </div>
  );
}

export default function Ask() {
  const { data: config, error: configError, isLoading: configLoading, mutate: refreshConfig } =
    useSWR<WorkspaceConfig>("/api/config", fetchJson, {
      revalidateOnFocus: false,
      shouldRetryOnError: false,
    });
  const { data: skillsResponse } = useSWR<SkillsResponse>("/api/skills", fetchJson, {
    revalidateOnFocus: false,
    shouldRetryOnError: false,
  });

  const [selectedModel, setSelectedModel] = useState<string>();
  const [input, setInput] = useState("");
  const [files, setFiles] = useState<FileUIPart[]>([]);
  const [activeSkills, setActiveSkills] = useState<string[]>([]);
  const [conversationId, setConversationId] = useState(createConversationId);
  const models = config?.models ?? [];
  const providers = config?.providers ?? [];
  const modelErrors = config?.modelErrors ?? [];
  const skills = skillsResponse?.skills ?? [];
  const model = selectedModel ?? config?.defaultModel ?? "";

  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const endRef = useRef<HTMLDivElement | null>(null);
  const shouldFollowLatestRef = useRef(true);
  const [showJumpToLatest, setShowJumpToLatest] = useState(false);
  const transport = useMemo(() => new DefaultChatTransport({ api: "/api/chat" }), []);
  const {
    messages,
    sendMessage,
    status,
    error: chatError,
    stop,
    regenerate,
    setMessages,
    clearError,
  } = useChat<ChatMessage>({ transport });

  const busy = status === "submitted" || status === "streaming";
  const canSend = !busy && Boolean(model) && (input.trim().length > 0 || files.length > 0);
  const turns = useMemo(() => groupTurns(messages), [messages]);
  const empty = turns.length === 0;
  const latestTurn = turns[turns.length - 1];
  const latestParts = latestTurn?.answer?.parts ?? [];
  const latestHasText = latestParts.some((part) => part.type === "text" && part.text.length > 0);
  const latestUsesTools = latestParts.some((part) => isToolUIPart<ChatTools>(part));
  const liveStatus = busy
    ? status === "submitted"
      ? "Quillon is preparing your response."
      : latestUsesTools && !latestHasText
        ? "Quillon is using tools."
        : latestHasText
          ? "Quillon is responding."
          : "Quillon is thinking."
    : latestTurn?.answer
      ? "Response complete."
      : "";

  useEffect(() => {
    const onNewConversation = () => {
      if (busy) stop();
      clearError();
      setMessages([]);
      setInput("");
      setFiles([]);
      setActiveSkills([]);
      setConversationId(createConversationId());
      shouldFollowLatestRef.current = true;
      setShowJumpToLatest(false);
      inputRef.current?.focus({ preventScroll: true });
    };
    window.addEventListener("quillon:new-thread", onNewConversation);
    return () => window.removeEventListener("quillon:new-thread", onNewConversation);
  }, [busy, clearError, setMessages, stop]);

  useEffect(() => {
    const updateScrollFollow = () => {
      const distanceFromLatest = document.documentElement.scrollHeight - window.scrollY - window.innerHeight;
      const atLatest = distanceFromLatest <= 140;
      shouldFollowLatestRef.current = atLatest;
      setShowJumpToLatest(busy && !atLatest);
    };

    updateScrollFollow();
    window.addEventListener("scroll", updateScrollFollow, { passive: true });
    window.addEventListener("resize", updateScrollFollow);
    return () => {
      window.removeEventListener("scroll", updateScrollFollow);
      window.removeEventListener("resize", updateScrollFollow);
    };
  }, [busy]);

  useEffect(() => {
    if (messages.length === 0 || !shouldFollowLatestRef.current) return;
    const frame = window.requestAnimationFrame(() => {
      endRef.current?.scrollIntoView({ block: "end", behavior: "auto" });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [messages, status]);

  function submit() {
    if (!canSend) return;
    shouldFollowLatestRef.current = true;
    setShowJumpToLatest(false);
    sendMessage(
      { text: input.trim(), files },
      { body: { model, conversationId, skills: activeSkills } },
    );
    setInput("");
    setFiles([]);
  }

  function handleFileChange(event: ChangeEvent<HTMLInputElement>) {
    void Promise.all(Array.from(event.target.files ?? [], toFileUIPart)).then((picked) => {
      setFiles((previous) => [...previous, ...picked]);
      event.target.value = "";
    });
  }

  const composer = (
    <form
      className="chat-composer"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      {files.length > 0 && (
        <ul className="chat-attachments" aria-label="Selected attachments">
          {files.map((file) => (
            <li key={file.filename ?? file.url}>
              <span className="chat-attachment-type" aria-hidden="true">FILE</span>
              <span>{file.filename ?? "Attachment"}</span>
              <button
                type="button"
                aria-label={`Remove ${file.filename ?? "attachment"}`}
                onClick={() => setFiles((previous) => previous.filter((item) => item !== file))}
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
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
        rows={empty ? 3 : 2}
        aria-label="Message Quillon"
        placeholder={empty ? "Ask a question, share a file, or describe what you need…" : "Continue the conversation…"}
        onChange={(event) => setInput(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.shiftKey) {
            if (event.nativeEvent.isComposing || event.keyCode === 229) return;
            event.preventDefault();
            submit();
          }
        }}
      />
      <div className="chat-composer-footer">
        <label className="chat-attach" title="Attach a file">
          <input
            type="file"
            multiple
            className="sr-only"
            onChange={handleFileChange}
            aria-label="Attach files"
          />
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M20 11.5l-8.2 8.2a5 5 0 0 1-7.1-7.1l8.5-8.5a3.3 3.3 0 0 1 4.7 4.7l-8.5 8.5a1.7 1.7 0 0 1-2.4-2.4l7.8-7.8" />
          </svg>
          <span>Attach</span>
        </label>
        <span className="chat-composer-hint">
          {model ? model.split("/").slice(-1)[0] : "Choose a model to begin"} · Enter to send · Shift + Enter for a new line
        </span>
        {busy ? (
          <button type="button" className="chat-send chat-stop" onClick={() => stop()}>
            Stop
          </button>
        ) : (
          <button type="submit" className="chat-send" disabled={!canSend} aria-label="Send message">
            <span>Send</span>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M12 19V5M5 12l7-7 7 7" />
            </svg>
          </button>
        )}
      </div>
      {skills.length > 0 && (
        <div className="chat-skills" role="group" aria-label="Skills for this conversation">
          <span>Skills</span>
          {skills.map((skill) => {
            const active = activeSkills.includes(skill.id);
            return (
              <button
                key={skill.id}
                type="button"
                aria-pressed={active}
                title={skill.description}
                onClick={() => setActiveSkills((previous) => active
                  ? previous.filter((id) => id !== skill.id)
                  : [...previous, skill.id])}
              >
                {skill.name}
              </button>
            );
          })}
        </div>
      )}
    </form>
  );

  const header = (
    <ChatHeader
      hasConversation={!empty}
      model={model}
      models={models}
      providers={providers}
      loading={configLoading}
      configError={configError}
      modelErrors={modelErrors}
      onModelChange={setSelectedModel}
    />
  );

  if (empty) {
    return (
      <div className="chat-ui" data-chat-state="empty">
        {header}
        <main className="chat-empty-page">
          <section className="chat-intro" aria-labelledby="chat-intro-title">
            <p className="chat-kicker"><span aria-hidden="true" /> Your AI workspace</p>
            <h2 id="chat-intro-title">Bring your work. Leave with clarity.</h2>
            <p className="chat-lede">
              Ask about a file, explore a dataset, or hand off a task. Your models, tools, and working context stay together from the first question to the final answer.
            </p>
          </section>
          {!configLoading && models.length === 0 && (
            <ProviderNotice
              loading={configLoading}
              error={configError}
              modelErrors={modelErrors}
              onRetry={() => { void refreshConfig(); }}
            />
          )}
          {models.length > 0 && modelErrors.length > 0 && (
            <p className="chat-provider-note" role="status">Some provider catalogs could not be refreshed: {modelErrors.join(" ")}</p>
          )}
          <div className="chat-empty-composer">{composer}</div>
          <section className="chat-suggestions" aria-labelledby="chat-suggestions-title">
            <div className="chat-suggestions-heading">
              <div>
                <p className="chat-section-kicker">A place to begin</p>
                <h3 id="chat-suggestions-title">Start with a task</h3>
              </div>
              <span>Choose a prompt, then make it yours</span>
            </div>
            <ul>
              {starters.map((starter) => (
                <li key={starter.title}>
                  <button
                    type="button"
                    onClick={() => {
                      setInput(starter.prompt);
                      inputRef.current?.focus({ preventScroll: true });
                    }}
                  >
                    <span className="chat-suggestion-icon" aria-hidden="true">
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round">
                        <path d={starter.icon} />
                      </svg>
                    </span>
                    <span className="chat-suggestion-copy">
                      <strong>{starter.title}</strong>
                      <span>{starter.detail}</span>
                    </span>
                    <svg className="chat-suggestion-arrow" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <path d="M5 12h14M13 6l6 6-6 6" />
                    </svg>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        </main>
      </div>
    );
  }

  return (
    <div className="chat-ui" data-chat-state="active">
      {header}
      <main className="chat-conversation">
        <section className="chat-thread" aria-label="Conversation">
          {turns.map((turn, index) => {
            const last = index === turns.length - 1;
            const answer = turn.answer;
            const parts = answer?.parts ?? [];
            const text = parts.map((part) => (part.type === "text" ? part.text : "")).join("\n\n").trim();
            const tools = parts.filter((part) => isToolUIPart<ChatTools>(part));
            const sources = parts.filter((part) => part.type === "source-url");
            const metadata = answer?.metadata;
            const pending = last && busy && !text && tools.length === 0;
            const streaming = last && status === "streaming";
            const answerInProgress = last && busy;
            const selectedModelId = metadata?.model ?? model;
            const modelLabel = models.find((option) => option.id === selectedModelId)?.label ?? (selectedModelId || "Assistant");
            const attachments = turn.question.parts.filter((part) => part.type === "file");

            return (
              <article key={turn.id} className="chat-turn" aria-label={`Conversation turn ${index + 1}`}>
                <div className="chat-question-row">
                  <span className="chat-question-label">You</span>
                  <div className="chat-question-content">
                    {questionText(turn.question) && <p>{questionText(turn.question)}</p>}
                    {attachments.length > 0 && (
                      <ul className="chat-question-files" aria-label="Attached files">
                        {attachments.map((file, fileIndex) => file.type === "file" ? (
                          <li key={`${file.filename ?? "file"}-${fileIndex}`}>
                            {file.mediaType.startsWith("image/")
                              ? <img src={file.url} alt={file.filename ?? "Attached image"} />
                              : <span>{file.filename ?? file.mediaType}</span>}
                          </li>
                        ) : null)}
                      </ul>
                    )}
                  </div>
                </div>

                <div className="chat-answer-row">
                  <div className="chat-answer-mark" aria-hidden="true"><BrandMark /></div>
                  <div className="chat-answer-content" aria-busy={answerInProgress}>
                    <div className="chat-answer-heading">
                      <strong>Quillon</strong>
                      <span>{modelLabel}</span>
                      {answerInProgress && (
                        <span className="chat-stream-state" aria-hidden="true">
                          <i />
                          {status === "submitted" ? "Starting" : tools.length > 0 && !text ? "Using tools" : text ? "Responding" : "Thinking"}
                        </span>
                      )}
                    </div>
                    {pending && !text ? (
                      <div className="chat-thinking" aria-hidden="true">
                        <span /><span /><span />
                      </div>
                    ) : (
                      parts.map((part, partIndex) => part.type === "text" ? (
                        <div key={partIndex} className="chat-prose">
                          <MarkdownLite text={part.text} />
                          {streaming && partIndex === parts.length - 1 && <span className="caret" aria-hidden="true" />}
                        </div>
                      ) : null)
                    )}
                    {tools.length > 0 && (
                      <details className="chat-activity">
                        <summary>
                          <span>{tools.length} {tools.length === 1 ? "tool" : "tools"} used</span>
                          <span>View activity</span>
                        </summary>
                        <div className="chat-activity-body">
                          {tools.map((part, partIndex) => isToolUIPart<ChatTools>(part)
                            ? <ToolPartView key={partIndex} part={part} />
                            : null)}
                        </div>
                      </details>
                    )}
                    {sources.length > 0 && (
                      <details className="chat-sources">
                        <summary>{sources.length} {sources.length === 1 ? "source" : "sources"}</summary>
                        <ol>
                          {sources.map((source, sourceIndex) => source.type === "source-url" ? (
                            <li key={source.sourceId}>
                              <a href={source.url} target="_blank" rel="noreferrer">
                                <span>{String(sourceIndex + 1).padStart(2, "0")}</span>
                                <strong>{source.title ?? hostOf(source.url)}</strong>
                                <small>{hostOf(source.url)}</small>
                              </a>
                            </li>
                          ) : null)}
                        </ol>
                      </details>
                    )}
                    {answer && !streaming && (
                      <footer className="chat-answer-footer">
                        {text && <CopyButton value={text} label="Copy answer" />}
                        {last && (
                          <button type="button" className="chat-action-button" onClick={() => regenerate()}>
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                              <path d="M20 7v5h-5M4 17v-5h5M5.5 9a7 7 0 0 1 11.9-2L20 12M4 12l2.6 5a7 7 0 0 0 11.9-2" />
                            </svg>
                            Retry
                          </button>
                        )}
                        {metadata?.ms !== undefined && (
                          <span className="chat-answer-meta">
                            {(metadata.ms / 1000).toFixed(1)} s
                            {metadata.outputTokens != null ? ` · ${metadata.outputTokens} tokens` : ""}
                          </span>
                        )}
                        {metadata && (
                          <details className="chat-run-details">
                            <summary>Details</summary>
                            <dl>
                              <div><dt>Model</dt><dd>{metadata.model ?? model ?? "—"}</dd></div>
                              <div><dt>Duration</dt><dd>{metadata.ms !== undefined ? `${metadata.ms} ms` : "—"}</dd></div>
                              <div><dt>Tokens in / out</dt><dd>{metadata.inputTokens ?? "—"} / {metadata.outputTokens ?? "—"}</dd></div>
                              <div><dt>Finish reason</dt><dd>{metadata.finishReason ?? "—"}</dd></div>
                            </dl>
                          </details>
                        )}
                      </footer>
                    )}
                  </div>
                </div>
              </article>
            );
          })}
          {chatError && (
            <div className="chat-error" role="alert">
              <div>
                <strong>The model couldn&apos;t complete that reply</strong>
                <p>{chatError.message}</p>
              </div>
              <button type="button" onClick={() => regenerate()}>Try again</button>
            </div>
          )}
          <div ref={endRef} />
        </section>
        <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">{liveStatus}</div>
        <div className="chat-dock">
          {showJumpToLatest && (
            <button
              type="button"
              className="chat-jump-latest"
              onClick={() => {
                shouldFollowLatestRef.current = true;
                setShowJumpToLatest(false);
                endRef.current?.scrollIntoView({ block: "end", behavior: "smooth" });
              }}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M12 5v14m-7-7 7 7 7-7" />
              </svg>
              Jump to latest
            </button>
          )}
          {modelErrors.length > 0 && models.length > 0 && (
            <p className="chat-provider-note" role="status">Some provider catalogs are unavailable: {modelErrors.join(" ")}</p>
          )}
          {composer}
        </div>
      </main>
    </div>
  );
}
