"use client";

import { useEffect, useRef, useState } from "react";
import type { SandboxFile, SandboxResult } from "@/lib/sandbox";
import {
  CopyButton,
  Metric,
  Pill,
  countLines,
  formatBytes,
  formatMs,
  type Tone,
} from "./ui-bits";

type Limits = {
  timeoutMs: number;
  minTimeoutMs: number;
  codeChars: number;
  fileChars: number;
  files: number;
  outputChars: number;
};

type SandboxMeta = { languages: string[]; limits: Limits };

const FALLBACK: SandboxMeta = {
  languages: ["javascript", "typescript", "python", "bash", "ruby", "php"],
  limits: { timeoutMs: 15_000, minTimeoutMs: 100, codeChars: 100_000, fileChars: 500_000, files: 20, outputChars: 100_000 },
};

const DEFAULTS: Record<string, string> = {
  python: `import json, statistics\n\nwith open("data.json") as f:\n    data = json.load(f)\n\nvalues = [r["score"] for r in data]\nprint("rows:", len(values))\nprint("mean:", round(statistics.mean(values), 2))\nprint("min/max:", min(values), max(values))\n`,
  javascript: `const rows = [3, 1, 4, 1, 5, 9, 2, 6];\nconst mean = rows.reduce((a, b) => a + b, 0) / rows.length;\nconsole.log("rows:", rows.length);\nconsole.log("mean:", mean.toFixed(2));\nconsole.error("stderr stays separate");\n`,
  typescript: `type Point = { x: number; y: number };\nconst pts: Point[] = [{ x: 1, y: 2 }, { x: 3, y: 4 }];\nconst dist = Math.hypot(pts[1].x - pts[0].x, pts[1].y - pts[0].y);\nconsole.log("distance:", dist.toFixed(3));\n`,
  bash: `set -e\necho "shell: $0"\nfor f in *.json; do echo "input: $f"; done\nprintf "done\\n"\n`,
  ruby: `puts "ruby #{RUBY_VERSION}"\n[1, 2, 3].each { |n| puts n * n }\n`,
  php: `<?php\necho "php " . PHP_VERSION . "\\n";\n$rows = [2, 4, 6];\necho "sum: " . array_sum($rows) . "\\n";\n`,
};

const SAMPLE_FILE: SandboxFile = {
  name: "data.json",
  content: JSON.stringify(
    [
      { id: 1, score: 82 },
      { id: 2, score: 91 },
      { id: 3, score: 76 },
    ],
    null,
    2,
  ),
};

function statusOf(result: SandboxResult): { tone: Tone; label: string } {
  if (result.timedOut) return { tone: "err", label: "timed out" };
  if (result.error) return { tone: "err", label: "failed" };
  if (result.exitCode === 0) return { tone: "ok", label: "exit 0" };
  return { tone: "warn", label: `exit ${result.exitCode}` };
}

function Pane({
  title,
  text,
  empty,
  tone,
}: {
  title: string;
  text: string;
  empty: string;
  tone: Tone;
}) {
  return (
    <div className={`sb-pane sb-pane-${tone}`}>
      <div className="sb-pane-head">
        <span className="gp-label">{title}</span>
        <span className="gp-fineprint">
          <span>{countLines(text)} lines</span>
          <span>{formatBytes(text.length)}</span>
          {text && <CopyButton value={text} label={`Copy ${title.toLowerCase()}`} />}
        </span>
      </div>
      {text ? <pre className="sb-out">{text}</pre> : <p className="gp-muted sb-empty">{empty}</p>}
    </div>
  );
}

export default function SandboxPanel() {
  const [lim, setLim] = useState<SandboxMeta>(FALLBACK);
  const [language, setLanguage] = useState("python");
  const [code, setCode] = useState(DEFAULTS.python);
  const [stdin, setStdin] = useState("");
  const [showStdin, setShowStdin] = useState(false);
  const [timeoutMs, setTimeoutMs] = useState(10_000);
  const [custom, setCustom] = useState("");
  const [files, setFiles] = useState<SandboxFile[]>([SAMPLE_FILE]);
  const [notice, setNotice] = useState<string | null>(null);
  const [result, setResult] = useState<SandboxResult | null>(null);
  const [landedAt, setLandedAt] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [openFile, setOpenFile] = useState<string | null>(null);
  const [history, setHistory] = useState<{ id: number; label: string; result: SandboxResult }[]>([]);
  const abort = useRef<AbortController | null>(null);
  const runCounter = useRef(0);

  useEffect(() => {
    let alive = true;
    fetch("/api/sandbox")
      .then((r) => r.json())
      .then((data: SandboxMeta) => {
        if (!alive || !data?.languages) return;
        setLim(data);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  const limits = lim.limits;
  const codeOver = code.length > limits.codeChars;
  const filesOver = files.length > limits.files;
  const filesChars = files.reduce((sum, f) => sum + f.content.length, 0);

  const pickLanguage = (next: string) => {
    if (code === DEFAULTS[language]) setCode(DEFAULTS[next] ?? "");
    setLanguage(next);
  };

  const addFiles = async (list: FileList | null) => {
    if (!list?.length) return;
    const incoming: SandboxFile[] = [];
    const skipped: string[] = [];
    for (const file of Array.from(list)) {
      if (file.size > limits.fileChars) {
        skipped.push(`${file.name} (over ${formatBytes(limits.fileChars)})`);
        continue;
      }
      const text = await file.text();
      if (text.includes("\u0000")) {
        skipped.push(`${file.name} (binary)`);
        continue;
      }
      incoming.push({ name: file.name, content: text });
    }
    setFiles((f) => [...f, ...incoming].slice(0, limits.files));
    setNotice(skipped.length ? `Skipped ${skipped.join(", ")}` : null);
  };

  const run = async () => {
    if (busy || !code.trim() || codeOver) return;
    const controller = new AbortController();
    abort.current = controller;
    setBusy(true);
    setError(null);
    const command = custom.trim() ? custom.trim().split(/\s+/) : undefined;
    try {
      const res = await fetch("/api/sandbox", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          language,
          code,
          files: files.length ? files : undefined,
          stdin: stdin || undefined,
          timeoutMs,
          command,
        }),
        signal: controller.signal,
      });
      const data = (await res.json()) ?? {};
      if (!res.ok) throw new Error(data?.error?.message ?? `HTTP ${res.status}`);
      const out = data as SandboxResult;
      setResult(out);
      setLandedAt(new Date().toLocaleTimeString());
      runCounter.current += 1;
      const first = out.stdout.split("\n").find((l) => l.trim()) ?? "(no stdout)";
      setHistory((h) =>
        [
          {
            id: runCounter.current,
            label: `${out.language} · ${formatMs(out.durationMs)} · ${statusOf(out).label} · ${first.slice(0, 60)}`,
            result: out,
          },
          ...h,
        ].slice(0, 5),
      );
    } catch (e) {
      if ((e as Error).name === "AbortError") setError("Cancelled while waiting; the server run continues to its timeout.");
      else setError(e instanceof Error ? e.message : "Run failed.");
    } finally {
      setBusy(false);
      abort.current = null;
    }
  };

  const status = result ? statusOf(result) : null;

  return (
    <section className="card sb-panel" aria-label="Code sandbox">
      <div className="gp-head">
        <div>
          <h2>Code sandbox</h2>
          <p className="gp-sub">Any installed language · fresh temp dir · hard timeout</p>
        </div>
        <div className="gp-head-right">
          {lim.languages.length > 0 && <Pill tone="idle">{lim.languages.length} languages</Pill>}
          {status && <Pill tone={status.tone}>{status.label}</Pill>}
        </div>
      </div>

      <div className="sb-editor">
        <div className="sb-editor-bar">
          <label className="gp-field">
            <span className="gp-label">Language</span>
            <select className="gp-select" aria-label="Language" value={language} onChange={(e) => pickLanguage(e.target.value)}>
              {lim.languages.map((l) => (
                <option key={l} value={l}>
                  {l}
                </option>
              ))}
            </select>
          </label>
          <div className="gp-fineprint">
            <span>{code.length} chars</span>
            <span>{countLines(code)} lines</span>
            <span className={codeOver ? "sb-over" : ""}>limit {formatBytes(limits.codeChars)}</span>
            <button type="button" className="gp-ghost" onClick={() => setCode(DEFAULTS[language] ?? "")}>
              Reset code
            </button>
          </div>
        </div>
        <textarea
          className="sb-code"
          aria-label="Code"
          spellCheck={false}
          value={code}
          onChange={(e) => setCode(e.target.value)}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === "Enter") run();
          }}
        />
        <div className="sb-run-bar">
          <div className="sb-timeout">
            <label className="gp-label" htmlFor="sb-timeout">
              Timeout
            </label>
            <input
              id="sb-timeout"
              type="range"
              min={limits.minTimeoutMs}
              max={limits.timeoutMs}
              step={100}
              value={timeoutMs}
              onChange={(e) => setTimeoutMs(Number(e.target.value))}
              aria-label="Timeout in milliseconds"
            />
            <span className="gp-mono">{formatMs(timeoutMs)}</span>
            <span className="gp-fineprint">max {formatMs(limits.timeoutMs)}</span>
          </div>
          <div className="gp-inline">
            <button type="button" className="gp-ghost" onClick={() => setShowStdin((v) => !v)} aria-expanded={showStdin}>
              {showStdin ? "Hide stdin" : `stdin${stdin ? ` (${stdin.length})` : ""}`}
            </button>
            <button type="button" className="gp-btn" onClick={run} disabled={busy || !code.trim() || codeOver}>
              {busy ? "Running…" : "Run code"}
            </button>
            {busy && (
              <button type="button" className="gp-ghost" onClick={() => abort.current?.abort()}>
                Cancel
              </button>
            )}
          </div>
        </div>
        {showStdin && (
          <label className="gp-field">
            <span className="gp-label">Standard input</span>
            <textarea
              className="sb-stdin"
              aria-label="Standard input"
              rows={3}
              value={stdin}
              onChange={(e) => setStdin(e.target.value)}
              placeholder="Fed to the program on stdin"
            />
          </label>
        )}
      </div>

      <div className="gp-block">
        <div className="gp-block-head">
          <h3>Inputs</h3>
          <div className="gp-inline">
            <Pill tone={filesOver ? "err" : "idle"}>
              {files.length}/{limits.files} files
            </Pill>
            <Pill tone="idle">{formatBytes(filesChars)}</Pill>
            <label className="gp-btn gp-btn-sm">
              Attach files
              <input
                type="file"
                multiple
                hidden
                aria-label="Attach input files"
                onChange={(e) => {
                  void addFiles(e.target.files);
                  e.target.value = "";
                }}
              />
            </label>
          </div>
        </div>
        <div className="gp-fineprint">
          <span>written next to the entry file, readable by name</span>
          <span>text only, {formatBytes(limits.fileChars)} each</span>
        </div>
        {notice && <p className="gp-alert gp-alert-warn">{notice}</p>}
        <ul className="sb-files">
          {files.map((f, i) => (
            <li key={`${f.name}-${i}`} className="sb-file">
              <button
                type="button"
                className="sb-file-name"
                onClick={() => setOpenFile(openFile === `${f.name}-${i}` ? null : `${f.name}-${i}`)}
                aria-expanded={openFile === `${f.name}-${i}`}
              >
                <span className="gp-mono">{f.name}</span>
                <span className="gp-fineprint">
                  {formatBytes(f.content.length)} · {countLines(f.content)} lines
                </span>
              </button>
              <button
                type="button"
                className="gp-ghost"
                aria-label={`Remove ${f.name}`}
                onClick={() => setFiles((all) => all.filter((_, idx) => idx !== i))}
              >
                Remove
              </button>
              {openFile === `${f.name}-${i}` && <pre className="sb-file-preview">{f.content.slice(0, 2000)}</pre>}
            </li>
          ))}
          {files.length === 0 && <li className="gp-muted sb-empty">No input files; the program runs alone.</li>}
        </ul>
        <details className="gp-details">
          <summary>Custom command (advanced)</summary>
          <input
            className="gp-input gp-mono"
            aria-label="Custom command"
            placeholder='e.g. ghc -e "main" main.hs'
            value={custom}
            onChange={(e) => setCustom(e.target.value)}
          />
        </details>
        <p className="gp-fineprint">Custom command overrides the interpreter for one run; argv only, no shell.</p>
      </div>
      {error && (
        <p className="gp-alert gp-alert-err" role="alert">
          {error}
        </p>
      )}

      <div className="gp-block">
        <div className="gp-block-head">
          <h3>Output</h3>
          {result && (
            <div className="gp-inline">
              <Pill tone={statusOf(result).tone}>{statusOf(result).label}</Pill>
              <CopyButton
                value={`${result.stdout}${result.stderr ? `\n--- stderr ---\n${result.stderr}` : ""}`}
                label="Copy all"
              />
            </div>
          )}
        </div>
        {result ? (
          <>
            <div className="gp-metrics">
              <Metric label="duration" value={formatMs(result.durationMs)} />
              <Metric label="exit" value={result.exitCode ?? "—"} />
              <Metric label="timeout" value={formatMs(result.timeoutMs)} hint="Applied after clamping" />
              <Metric label="stdout" value={result.stdoutChars} />
              <Metric label="stderr" value={result.stderrChars} />
              <Metric label="landed" value={landedAt ?? "—"} hint="Wall clock when this result arrived" />
            </div>
            <div className="gp-fineprint gp-mono">
              <span>$ {result.command.join(" ")}</span>
            </div>
            {result.truncated && (
              <p className="gp-alert gp-alert-warn">
                Output hit {formatBytes(limits.outputChars)} and was cut.
              </p>
            )}
            {result.error && <p className="gp-alert gp-alert-err">{result.error}</p>}
            <Pane title="stdout" text={result.stdout} empty="No standard output." tone="ok" />
            <Pane
              title="stderr"
              text={result.stderr}
              empty="No standard error."
              tone={result.stderr ? "warn" : "idle"}
            />
            <div className="gp-fineprint">
              <span>temp dir files:</span>
              {result.filesWritten.length > 0 ? (
                result.filesWritten.map((n) => (
                  <span key={n} className={`gp-mono ${n === result.entryFile ? "sb-entry" : ""}`}>
                    {n}
                    {n === result.entryFile ? " (entry)" : ""}
                  </span>
                ))
              ) : (
                <span>none</span>
              )}
            </div>
            <div className="gp-fineprint">
              <span>env: PATH, HOME only</span>
              <span>cwd: fresh temp dir</span>
              <span>dir removed after the run</span>
            </div>
          </>
        ) : (
          <p className="gp-muted sb-empty">Run the code to see stdout, stderr, exit code and timing.</p>
        )}
      </div>

      {history.length > 0 && (
        <div className="gp-block">
          <div className="gp-block-head">
            <h3>Recent runs</h3>
            <span className="gp-fineprint">{history.length} kept</span>
          </div>
          <ul className="gp-history">
            {history.map((h) => (
              <li key={h.id}>
                <button type="button" className="gp-history-row" onClick={() => { setResult(h.result); setLandedAt(null); }}>
                  <span className="gp-mono sb-history-label">{h.label}</span>
                  <Pill tone={statusOf(h.result).tone}>{statusOf(h.result).label}</Pill>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
