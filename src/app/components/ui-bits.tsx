"use client";

import { useEffect, useState, type ReactNode } from "react";

export function formatMs(ms: number): string {
  if (!Number.isFinite(ms)) return "—";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export function countLines(text: string): number {
  if (!text) return 0;
  return text.split("\n").length;
}

export type Tone = "idle" | "run" | "ok" | "warn" | "err";

export function Pill({
  tone = "idle",
  children,
  title,
}: {
  tone?: Tone;
  children: ReactNode;
  title?: string;
}) {
  return (
    <span className={`gp-pill gp-pill-${tone}`} title={title}>
      {children}
    </span>
  );
}

export function Metric({
  label,
  value,
  hint,
}: {
  label: string;
  value: ReactNode;
  hint?: string;
}) {
  return (
    <div className="gp-metric" title={hint}>
      <span className="gp-metric-label">{label}</span>
      <span className="gp-metric-value">{value}</span>
    </div>
  );
}

export function CopyButton({ value, label = "Copy" }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1400);
    return () => clearTimeout(t);
  }, [copied]);
  return (
    <button
      type="button"
      className="gp-ghost gp-copy"
      aria-label={label}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setCopied(true);
        } catch {
          setCopied(false);
        }
      }}
    >
      {copied ? "Copied" : label}
    </button>
  );
}

/** Horizontal split bar: segments sized by weight, labelled by title attribute. */
export function SplitBar({
  segments,
}: {
  segments: { label: string; value: number; tone: Tone }[];
}) {
  const total = segments.reduce((sum, s) => sum + Math.max(0, s.value), 0);
  if (total <= 0) return null;
  return (
    <div className="gp-split" role="img" aria-label={segments.map((s) => `${s.label} ${Math.round(s.value)}ms`).join(", ")}>
      {segments.map((s) => (
        <span
          key={s.label}
          className={`gp-split-seg gp-split-${s.tone}`}
          style={{ width: `${(Math.max(0, s.value) / total) * 100}%` }}
          title={`${s.label}: ${formatMs(s.value)}`}
        />
      ))}
    </div>
  );
}

/** Thin level meter (complexity, confidence, etc.). */
export function Meter({ level, max = 3, tone = "run", label }: { level: number; max?: number; tone?: Tone; label: string }) {
  return (
    <span className="gp-meter" role="img" aria-label={`${label} ${level} of ${max}`}>
      {Array.from({ length: max }, (_, i) => (
        <span key={i} className={`gp-meter-cell ${i < level ? `gp-meter-${tone}` : ""}`} />
      ))}
    </span>
  );
}
