// AI-legibility lint: clarity and structure, never gaming.
//
// If evaluators use AI-assisted summaries, a proposal that buries its
// discriminators in dense narrative risks being summarized incompletely. The
// honest fix is clarity — headings that mirror Section M, self-contained
// measurable claims, defined acronyms, resolving cross-references — which helps
// human evaluators too.
//
// The hard rule from the design holds here as code: Quillon never inserts
// hidden text, metadata payloads or instructions aimed at an AI evaluator, and
// this lint fails a draft that contains any of them.

import { findConcealedContent, sentences, unresolvedCrossReferences, type ConcealedContent } from "./quote-check";
import type { Criterion } from "./types";

export interface LegibilityCheck {
  id: string;
  label: string;
  verdict: "pass" | "warn" | "fail";
  detail: string;
  evidence?: string;
}

export interface LegibilityReport {
  verdict: "pass" | "warn" | "fail";
  checks: LegibilityCheck[];
  concealed: ConcealedContent[];
  coverage: { criterionId: string; factor: string; addressed: boolean }[];
  disclaimer: string;
}

const DISCRIMINATORS = [
  "best-in-class",
  "world-class",
  "state of the art",
  "state-of-the-art",
  "proven",
  "unmatched",
  "unique",
  "seamless",
  "cutting-edge",
  "industry-leading",
  "superior",
  "innovative",
];

const EVIDENCE_MARKERS = /\b(?:cpars|contract|task order|gs-|nng|w\d{2}|dod|agency|award|ppq|section|exhibit|appendix|figure|table|percent|%|\$|days?|hours?|months?|years?)\b/i;

function headingLike(line: string): boolean {
  const trimmed = line.trim();
  if (trimmed.length === 0 || trimmed.length > 120) return false;
  return /^#{1,6}\s/.test(trimmed) || /^\d+(?:\.\d+)*\.?\s+\S/.test(trimmed) || /^[A-Z][A-Z0-9 &/,\-]{8,}$/.test(trimmed);
}

function lines(text: string): string[] {
  return text.split(/\r?\n/);
}

function coverageCheck(text: string, criteria: Criterion[]): { check: LegibilityCheck; coverage: LegibilityReport["coverage"] } {
  const factors = criteria.filter((c) => c.kind === "factor" || c.kind === "subfactor");
  if (factors.length === 0) {
    return {
      check: { id: "criteria_headings", label: "Section M headings mirrored", verdict: "warn", detail: "No Section M criteria were supplied, so heading coverage cannot be checked." },
      coverage: [],
    };
  }
  const normalised = text.toLowerCase();
  const headings = lines(text).filter(headingLike).map((l) => l.toLowerCase()).join("\n");
  const coverage = factors.map((c) => {
    const label = c.factor.toLowerCase().trim();
    const addressed = headings.includes(label) || normalised.includes(label);
    return { criterionId: c.id, factor: c.factor, addressed };
  });
  const missing = coverage.filter((c) => !c.addressed);
  const verdict = missing.length === 0 ? "pass" : missing.length <= 2 ? "warn" : "fail";
  return {
    check: {
      id: "criteria_headings",
      label: "Section M headings mirrored",
      verdict,
      detail:
        missing.length === 0
          ? `All ${coverage.length} evaluation factors appear under matching language.`
          : `${missing.length} of ${coverage.length} evaluation factors do not appear with the RFP's own language: ${missing.slice(0, 5).map((m) => m.factor).join(", ")}.`,
      evidence: missing[0]?.factor,
    },
    coverage,
  };
}

function discriminatorCheck(text: string): LegibilityCheck {
  const hits: { sentence: string; quantified: boolean }[] = [];
  for (const sentence of sentences(text)) {
    const lower = sentence.text.toLowerCase();
    if (!DISCRIMINATORS.some((d) => lower.includes(d))) continue;
    hits.push({ sentence: sentence.text, quantified: /\d/.test(sentence.text) && EVIDENCE_MARKERS.test(sentence.text) });
  }
  if (hits.length === 0) {
    return { id: "discriminators", label: "Discriminators are measurable", verdict: "warn", detail: "No discriminator language found; if the proposal has differentiators, state them plainly." };
  }
  const weak = hits.filter((h) => !h.quantified);
  const verdict = weak.length === 0 ? "pass" : weak.length <= 2 ? "warn" : "fail";
  return {
    id: "discriminators",
    label: "Discriminators are measurable",
    verdict,
    detail:
      weak.length === 0
        ? `All ${hits.length} discriminator statements pair a measurable claim with an evidence reference.`
        : `${weak.length} of ${hits.length} discriminator statements read as unsupported assertion rather than a measurable claim with evidence.`,
    evidence: weak[0]?.sentence.slice(0, 240),
  };
}

const ACRONYM = /\b([A-Z]{2,6})\b/g;

function acronymCheck(text: string): LegibilityCheck {
  const defined = new Set<string>();
  for (const match of text.matchAll(/\(([A-Z]{2,6})\)/g)) defined.add(match[1] ?? "");
  const seen = new Map<string, number>();
  const ignored = new Set(["RFP", "RFI", "FAQ", "USA", "USD", "PDF", "ID", "IT", "AI", "API", "URL", "REST", "HTTP", "HTTPS", "POC", "TBD", "N/A", "CPARS", "GAO"]);
  for (const match of text.matchAll(ACRONYM)) {
    const token = match[1] ?? "";
    if (ignored.has(token) || token.length < 2) continue;
    seen.set(token, (seen.get(token) ?? 0) + 1);
  }
  const undefinedTokens = [...seen.keys()].filter((t) => !defined.has(t)).slice(0, 10);
  return {
    id: "acronyms",
    label: "Acronyms defined at first use",
    verdict: undefinedTokens.length === 0 ? "pass" : undefinedTokens.length <= 3 ? "warn" : "fail",
    detail:
      undefinedTokens.length === 0
        ? "Every acronym has a parenthetical definition."
        : `${undefinedTokens.length} acronym${undefinedTokens.length === 1 ? "" : "s"} never defined: ${undefinedTokens.join(", ")}.`,
  };
}

function crossReferenceCheck(text: string): LegibilityCheck {
  const missing = unresolvedCrossReferences(text);
  return {
    id: "cross_references",
    label: "Cross-references resolve",
    verdict: missing.length === 0 ? "pass" : "fail",
    detail: missing.length === 0 ? "Every 'see Section' reference resolves." : `Unresolved references: ${missing.join(", ")}.`,
  };
}

function tableCheck(text: string): LegibilityCheck {
  const rows = lines(text).filter((l) => l.includes("|") && l.trim().length > 2);
  if (rows.length < 3) {
    return { id: "tables", label: "Tables are machine-readable", verdict: "pass", detail: "No tables detected; nothing to check." };
  }
  const widths = new Map<number, number>();
  for (const row of rows) {
    const cells = row.split("|").length;
    widths.set(cells, (widths.get(cells) ?? 0) + 1);
  }
  const dominant = [...widths.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 0;
  const irregular = rows.filter((r) => r.split("|").length !== dominant).length;
  return {
    id: "tables",
    label: "Tables are machine-readable",
    verdict: irregular === 0 ? "pass" : irregular <= 2 ? "warn" : "fail",
    detail:
      irregular === 0
        ? `${rows.length} table rows parsed with a consistent column count.`
        : `${irregular} of ${rows.length} table rows have an inconsistent column count; a summarizer may drop cells.`,
  };
}

function priceConsistencyCheck(text: string): LegibilityCheck {
  const values = new Map<string, Set<string>>();
  for (const match of text.matchAll(/([A-Za-z][A-Za-z /\-]{2,40}?)\s*(?:of|is|:)?\s*\$([\d,]+(?:\.\d+)?)/g)) {
    const label = (match[1] ?? "").trim().toLowerCase();
    const value = match[2] ?? "";
    if (!/total|price|cost|amount/.test(label)) continue;
    const set = values.get(label) ?? new Set<string>();
    set.add(value);
    values.set(label, set);
  }
  const conflicts = [...values.entries()].filter(([, set]) => set.size > 1);
  return {
    id: "price_consistency",
    label: "Stated totals are consistent",
    verdict: conflicts.length === 0 ? "pass" : "fail",
    detail:
      conflicts.length === 0
        ? "No conflicting totals were found for the same labelled figure."
        : conflicts.map(([label, set]) => `"${label}" appears as ${[...set].join(" and ")}`).join("; "),
  };
}

function concealmentCheck(concealed: ConcealedContent[]): LegibilityCheck {
  return {
    id: "concealed_content",
    label: "No concealed or evaluator-addressed content",
    verdict: concealed.length === 0 ? "pass" : "fail",
    detail:
      concealed.length === 0
        ? "No hidden text, zero-width controls or AI-directed instructions found."
        : concealed.map((c) => `${c.kind}: ${c.detail}`).join(" "),
    evidence: concealed[0]?.kind,
  };
}

export function lintProposal(input: { text: string; criteria?: Criterion[] }): LegibilityReport {
  const text = input.text ?? "";
  const concealed = findConcealedContent(text);
  const { check: headings, coverage } = coverageCheck(text, input.criteria ?? []);
  const checks: LegibilityCheck[] = [
    headings,
    discriminatorCheck(text),
    acronymCheck(text),
    crossReferenceCheck(text),
    tableCheck(text),
    priceConsistencyCheck(text),
    concealmentCheck(concealed),
  ];
  const verdict = checks.some((c) => c.verdict === "fail") ? "fail" : checks.some((c) => c.verdict === "warn") ? "warn" : "pass";
  return {
    verdict,
    checks,
    concealed,
    coverage,
    disclaimer: "Clarity guidance only. Quillon never adds hidden text or instructions addressed to an automated evaluator.",
  };
}

const PREDICTION_PATTERN =
  /\b(?:\d{1,3}\s*%\s*(?:chance|probability|likely|likelihood)|probability of (?:winning|success|a successful protest)|odds of (?:winning|success)|likely to (?:win|succeed)|chance of (?:winning|success))\b/gi;

/**
 * Language policy: no win-probability numbers anywhere in a report. Returns
 * every offending phrase so a route can refuse to store the report.
 */
export function findOutcomePredictions(text: string): string[] {
  const out: string[] = [];
  for (const match of text.matchAll(PREDICTION_PATTERN)) if (match[0]) out.push(match[0]);
  return out;
}
