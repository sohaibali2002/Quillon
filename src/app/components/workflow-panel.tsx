"use client";

import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport, type UIMessage } from "ai";
import { useEffect, useMemo, useRef, useState } from "react";
import type { ChatTools } from "@/lib/ai-types";
import type { PlanPart, SummaryPart, TaskPart } from "@/lib/workflow";
import { MarkdownLite } from "./markdown-lite";
import {
  CopyButton,
  Meter,
  Metric,
  Pill,
  SplitBar,
  countLines,
  formatBytes,
  formatMs,
  type Tone,
} from "./ui-bits";

type WorkflowMessage = UIMessage<
  never,
  { plan: PlanPart; task: TaskPart; summary: SummaryPart },
  ChatTools
>;

// Mirrors the orchestrator's plan schema cap (1-5 subtasks) for the capacity meter.
const MAX_TASKS = 5;

const DEFAULT_PROMPT =
  "Run code that prints 6*7, then summarize the output in one sentence.";

const KIND_TONE: Record<PlanPart["tasks"][number]["kind"], Tone> = {
  research: "run",
  analysis: "warn",
  implementation: "ok",
};

const COMPLEXITY_LEVEL: Record<PlanPart["estimatedComplexity"], number> = {
  low: 1,
  medium: 2,
  high: 3,
};

type StageState = "idle" | "run" | "ok" | "err";

const STAGE_TONE: Record<StageState, Tone> = {
  idle: "idle",
  run: "run",
  ok: "ok",
  err: "err",
};

const STAGE_LABEL: Record<StageState, string> = {
  idle: "queued",
  run: "running",
  ok: "done",
  err: "failed",
};

function words(text: string): number {
  return text.trim() ? text.trim().split(/\s+/).length : 0;
}

function StageStep({
  index,
  title,
  detail,
  state,
}: {
  index: number;
  title: string;
  detail: string;
  state: StageState;
}) {
  return (
    <li className={`gp-stage gp-stage-${state}`}>
      <span className="gp-stage-num" aria-hidden="true">
        {state === "ok" ? "✓" : state === "err" ? "!" : index}
      </span>
      <span className="gp-stage-body">
        <span className="gp-stage-title">{title}</span>
        <span className="gp-stage-detail">{detail}</span>
      </span>
      <Pill tone={STAGE_TONE[state]}>{STAGE_LABEL[state]}</Pill>
    </li>
  );
}

export default function WorkflowPanel() {
  const [prompt, setPrompt] = useState(DEFAULT_PROMPT);
  const [model, setModel] = useState("");
  const [models, setModels] = useState<{ id: string; label: string }[]>([]);
  const [defaultModel, setDefaultModel] = useState("");
  const [history, setHistory] = useState<{ id: string; prompt: string; summary: SummaryPart }[]>([]);
  const [showWire, setShowWire] = useState(false);
  const transport = useMemo(() => new DefaultChatTransport({ api: "/api/workflow" }), []);
  const { messages, sendMessage, status, error, stop } = useChat<WorkflowMessage>({ transport });

  useEffect(() => {
    let alive = true;
    fetch("/api/config")
      .then((r) => r.json())
      .then((cfg: { defaultModel?: string; models?: { id: string; label: string }[] }) => {
        if (!alive) return;
        setModels(cfg.models ?? []);
        setDefaultModel(cfg.defaultModel ?? "");
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  const running = status === "streaming" || status === "submitted";
  const last = messages[messages.length - 1];
  const parts = last?.parts ?? [];
  const plan = parts.find((p) => p.type === "data-plan")?.data;
  const tasks = parts
    .filter((p) => p.type === "data-task")
    .map((p) => p.data)
    .sort((a, b) => a.index - b.index);
  const summary = parts.find((p) => p.type === "data-summary")?.data;
  const synthesis = parts
    .filter((p) => p.type === "text")
    .map((p) => p.text)
    .join("")
    .trim();

  const planState: StageState = plan ? "ok" : summary?.error ? "err" : running ? "run" : "idle";
  const workersState: StageState = plan
    ? tasks.length >= plan.tasks.length
      ? "ok"
      : summary?.error
        ? "err"
        : "run"
    : "idle";
  const synthState: StageState = synthesis
    ? summary
      ? "ok"
      : running
        ? "run"
        : "ok"
    : summary?.error && tasks.length > 0
      ? "err"
      : summary
        ? "ok"
        : "idle";

  const recorded = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!summary || !last || recorded.current.has(last.id)) return;
    recorded.current.add(last.id);
    setHistory((h) => [{ id: last.id, prompt, summary }, ...h].slice(0, 6));
  }, [summary, last, prompt]);

  const run = () => {
    if (!prompt.trim() || running) return;
    sendMessage({ text: prompt }, { body: model ? { model } : {} });
  };

  const modelName = summary?.model && summary.model !== "gateway default" ? summary.model : defaultModel;
  const slowestMs = tasks.reduce((max, t) => Math.max(max, t.meta.ms), 0);
  const kindCounts = plan
    ? plan.tasks.reduce<Record<string, number>>((acc, t) => {
        acc[t.kind] = (acc[t.kind] ?? 0) + 1;
        return acc;
      }, {})
    : {};
  const workerTokens = tasks.reduce((sum, t) => sum + t.meta.tokens, 0);
  const failedStage = summary?.error
    ? !plan
      ? "Orchestrator"
      : tasks.length < (plan?.tasks.length ?? 0)
        ? "Worker"
        : "Synthesizer"
    : null;
  const partCounts = [
    { label: "plan", n: plan ? 1 : 0 },
    { label: "task", n: tasks.length },
    { label: "text", n: synthesis ? 1 : 0 },
    { label: "summary", n: summary ? 1 : 0 },
  ];

  return (
    <section className="card gp-panel" aria-label="Multi-agent workflow">
      <div className="gp-head">
        <div>
          <h2>Multi-agent workflow</h2>
          <p className="gp-sub">
            Orchestrator plans · workers run in parallel · synthesizer merges
          </p>
        </div>
        <div className="gp-head-right">
          {summary && <Pill tone={summary.error ? "err" : "ok"}>{formatMs(summary.ms)} total</Pill>}
          <Pill tone={running ? "run" : "idle"}>{running ? "streaming" : status}</Pill>
        </div>
      </div>

      <ol className="gp-stages" aria-label="Workflow stages">
        <StageStep
          index={1}
          title="Orchestrator"
          detail={plan ? `${plan.tasks.length} subtasks · ${formatMs(plan.ms)}` : "waiting for a plan"}
          state={planState}
        />
        <StageStep
          index={2}
          title="Workers"
          detail={plan ? `${tasks.length}/${plan.tasks.length} landed` : "parallel fan-out"}
          state={workersState}
        />
        <StageStep
          index={3}
          title="Synthesizer"
          detail={synthesis ? `${words(synthesis)} words` : "merges worker output"}
          state={synthState}
        />
      </ol>

      <div className="gp-controls">
        <label className="gp-field gp-field-grow">
          <span className="gp-label">Request</span>
          <textarea
            className="gp-textarea"
            aria-label="Workflow prompt"
            value={prompt}
            rows={2}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === "Enter") run();
            }}
          />
        </label>
        <div className="gp-control-row">
          <label className="gp-field">
            <span className="gp-label">Model</span>
            <select className="gp-select" aria-label="Workflow model" value={model} onChange={(e) => setModel(e.target.value)}>
              <option value="">default · {(defaultModel || "gateway").split("/").pop()}</option>
              {models.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
            </select>
          </label>
          <button type="button" className="gp-btn" onClick={run} disabled={running || !prompt.trim()}>
            {running ? "Running…" : "Run workflow"}
          </button>
          {running && (
            <button type="button" className="gp-ghost" onClick={() => stop()}>
              Stop
            </button>
          )}
        </div>
        <div className="gp-fineprint">
          <span>{prompt.length} chars</span>
          <span>{words(prompt)} words</span>
          <span>⌘/Ctrl + Enter to run</span>
        </div>
      </div>

      {error && (
        <p className="gp-alert gp-alert-err" role="alert">
          Transport error: {error.message}
        </p>
      )}

      {plan && (
        <div className="gp-block">
          <div className="gp-block-head">
            <h3>Plan</h3>
            <div className="gp-inline">
              <Pill tone="run">{plan.estimatedComplexity} complexity</Pill>
              <Meter level={COMPLEXITY_LEVEL[plan.estimatedComplexity]} label="complexity" />
              <Pill tone="idle" title="Subtask capacity used">
                {plan.tasks.length}/{MAX_TASKS} slots
              </Pill>
            </div>
          </div>
          <div className="gp-fineprint">
            <span>model {plan.model}</span>
            <span>planned in {formatMs(plan.ms)}</span>
            {Object.entries(kindCounts).map(([kind, n]) => (
              <span key={kind}>
                {n}× {kind}
              </span>
            ))}
          </div>
          <ol className="gp-plan" aria-label="Planned subtasks">
            {plan.tasks.map((task, i) => {
              const done = tasks.find((t) => t.index === i);
              return (
                <li key={`${task.title}-${i}`} className={`gp-plan-row ${done ? "gp-plan-done" : ""}`}>
                  <span className="gp-plan-index">{i + 1}</span>
                  <span className="gp-plan-body">
                    <span className="gp-plan-title">{task.title}</span>
                    <span className="gp-plan-desc">{task.description}</span>
                  </span>
                  <span className="gp-plan-side">
                    <Pill tone={KIND_TONE[task.kind]}>{task.kind}</Pill>
                    <span className="gp-plan-wait">
                      {done ? `${formatMs(done.meta.ms)} · #${done.meta.arrival}` : planState === "ok" ? "queued" : "planned"}
                    </span>
                  </span>
                </li>
              );
            })}
          </ol>
        </div>
      )}

      {(tasks.length > 0 || (plan && workersState === "run")) && (
        <div className="gp-block">
          <div className="gp-block-head">
            <h3>Workers</h3>
            <div className="gp-inline">
              <Pill tone={workersState === "ok" ? "ok" : "run"}>{tasks.length} landed</Pill>
              {workerTokens > 0 && <Pill tone="idle">{workerTokens} tokens</Pill>}
            </div>
          </div>
          <div className="gp-workers">
            {plan?.tasks.map((task, i) => {
              const taskPart = tasks.find((t) => t.index === i);
              return (
                <article key={`${task.title}-${i}`} className="gp-worker" aria-label={`Worker ${i + 1}: ${task.title}`}>
                  <header className="gp-worker-head">
                    <span className="gp-plan-index">{i + 1}</span>
                    <span className="gp-worker-title">{task.title}</span>
                    <Pill tone={KIND_TONE[task.kind]}>{task.kind}</Pill>
                    <Pill tone={taskPart ? "ok" : running ? "run" : "idle"}>
                      {taskPart ? `#${taskPart.meta.arrival} done` : running ? "working" : "waiting"}
                    </Pill>
                  </header>
                  {taskPart ? (
                    <>
                      <div className="gp-fineprint">
                        <span>{formatMs(taskPart.meta.ms)}</span>
                        <span>{taskPart.meta.steps} steps</span>
                        <span>{taskPart.meta.tokens} tokens</span>
                        {taskPart.meta.tools.length > 0 ? (
                          <span>tools: {taskPart.meta.tools.join(", ")}</span>
                        ) : (
                          <span>no tools</span>
                        )}
                      </div>
                      <div
                        className="gp-worker-bar"
                        role="img"
                        aria-label={`${formatMs(taskPart.meta.ms)} of the slowest worker`}
                      >
                        <span style={{ width: `${slowestMs ? (taskPart.meta.ms / slowestMs) * 100 : 0}%` }} />
                      </div>
                      <div className="gp-section">
                        <span className="gp-label">Finding</span>
                        <p className="gp-text">{taskPart.result.result}</p>
                        <div className="gp-fineprint">
                          <span>{formatBytes(taskPart.result.result.length)}</span>
                          <span>{countLines(taskPart.result.result)} lines</span>
                          <CopyButton value={taskPart.result.result} label="Copy finding" />
                        </div>
                      </div>
                      <details className="gp-details">
                        <summary>Explanation</summary>
                        <p className="gp-text">{taskPart.result.explanation}</p>
                      </details>
                    </>
                  ) : (
                    <div className="gp-skeleton" aria-hidden="true">
                      <span />
                      <span />
                    </div>
                  )}
                </article>
              );
            })}
            {!plan && (
              <article className="gp-worker gp-worker-pending">
                <span className="gp-muted">Workers start once the orchestrator returns a plan.</span>
              </article>
            )}
          </div>
        </div>
      )}

      {(synthesis || synthState === "run") && (
        <div className="gp-block">
          <div className="gp-block-head">
            <h3>Synthesis</h3>
            {synthesis && (
              <div className="gp-inline">
                <Pill tone="idle">{words(synthesis)} words</Pill>
                <CopyButton value={synthesis} label="Copy answer" />
              </div>
            )}
          </div>
          {synthesis ? (
            <div className="gp-answer">
              <MarkdownLite text={synthesis} />
            </div>
          ) : (
            <div className="gp-skeleton" aria-hidden="true">
              <span />
              <span />
            </div>
          )}
          {synthesis && (
            <div className="gp-fineprint">
              <span>{synthesis.length} chars</span>
              <span>{countLines(synthesis)} lines</span>
              <span>{synthesis.split(/\n\s*\n/).filter(Boolean).length} blocks</span>
            </div>
          )}
        </div>
      )}

      {summary && (
        <div className="gp-block gp-run">
          <div className="gp-block-head">
            <h3>Run</h3>
            <div className="gp-inline">
              <Pill tone={summary.error ? "err" : "ok"}>{summary.error ? "failed" : "complete"}</Pill>
              <CopyButton value={JSON.stringify({ plan, tasks, summary }, null, 2)} label="Copy run JSON" />
            </div>
          </div>
          <div className="gp-metrics">
            <Metric label="total" value={formatMs(summary.ms)} />
            <Metric label="tasks" value={summary.tasks} hint="Subtasks the orchestrator planned" />
            <Metric label="tokens" value={summary.tokens} hint="Plan + workers + synthesis" />
            <Metric
              label="slowest"
              value={summary.slowest ? `${formatMs(summary.slowest.ms)}` : "—"}
              hint={summary.slowest?.title}
            />
            <Metric
              label="fastest"
              value={summary.fastest ? `${formatMs(summary.fastest.ms)}` : "—"}
              hint={summary.fastest?.title}
            />
            <Metric
              label="model"
              value={<span className="gp-mono" title={modelName || undefined}>{(modelName || "—").split("/").pop()}</span>}
            />
          </div>
          <SplitBar
            segments={[
              { label: "plan", value: summary.breakdown.planMs, tone: "run" },
              { label: "workers", value: summary.breakdown.workersMs, tone: "ok" },
              { label: "synthesis", value: summary.breakdown.synthMs, tone: "warn" },
            ]}
          />
          <div className="gp-legend">
            <span>
              <i className="gp-dot gp-split-run" /> plan {formatMs(summary.breakdown.planMs)}
            </span>
            <span>
              <i className="gp-dot gp-split-ok" /> workers {formatMs(summary.breakdown.workersMs)}
            </span>
            <span>
              <i className="gp-dot gp-split-warn" /> synthesis {formatMs(summary.breakdown.synthMs)}
            </span>
          </div>
          {summary.error && (
            <p className="gp-alert gp-alert-err" role="alert">
              {failedStage} stage failed after {formatMs(summary.ms)}: {summary.error}
            </p>
          )}
        </div>
      )}

      <div className="gp-foot">
        <button type="button" className="gp-ghost" onClick={() => setShowWire((v) => !v)} aria-expanded={showWire}>
          {showWire ? "Hide stream parts" : "Stream parts"}
        </button>
        <span className="gp-fineprint">
          {partCounts.map((p) => (
            <span key={p.label} className="gp-mono">
              {p.label} ×{p.n}
            </span>
          ))}
        </span>
      </div>
      {showWire && (
        <pre className="gp-wire" aria-label="Stream part counts">
{JSON.stringify(
  {
    stages: { plan: planState, workers: workersState, synthesis: synthState },
    arrived: tasks.map((t) => ({ index: t.index, arrival: t.meta.arrival, ms: t.meta.ms })),
    status,
  },
  null,
  2,
)}
        </pre>
      )}

      {history.length > 0 && (
        <div className="gp-block">
          <div className="gp-block-head">
            <h3>Recent runs</h3>
            <span className="gp-fineprint">{history.length} kept</span>
          </div>
          <ul className="gp-history">
            {history.map((entry) => (
              <li key={entry.id}>
                <button type="button" className="gp-history-row" onClick={() => setPrompt(entry.prompt)}>
                  <span className="gp-history-prompt">{entry.prompt}</span>
                  <span className="gp-fineprint">
                    <Pill tone={entry.summary.error ? "err" : "ok"}>
                      {entry.summary.error ? "failed" : "complete"}
                    </Pill>
                    <span>{entry.summary.tasks} tasks</span>
                    <span>{formatMs(entry.summary.ms)}</span>
                    <span>{entry.summary.tokens} tokens</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
