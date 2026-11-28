// Deterministic quote and cross-reference verification.
//
// The single hard guardrail of the module: a finding may only cite proposal
// text that exists verbatim in the source. This is the failure mode the public
// litigation alleges on the government side — an evaluation weakness quoting
// proposal content that was never written — so the check is a plain string
// match, not a model judgement.
//
// Matching is verbatim after a deliberately small normalisation: Unicode NFKC,
// typographic quotes and dashes folded to ASCII, whitespace runs collapsed and
// case ignored. Nothing semantic is permitted here.

import type { QuoteCheck } from "./types";

const MIN_QUOTE = 12;

function fold(ch: string): string {
  switch (ch) {
    case "\u2018":
    case "\u2019":
    case "\u201A":
    case "\u201B":
    case "\u2032":
      return "'";
    case "\u201C":
    case "\u201D":
    case "\u201E":
    case "\u201F":
    case "\u2033":
      return '"';
    case "\u2013":
    case "\u2014":
    case "\u2212":
      return "-";
    case "\u00A0":
    case "\u2007":
    case "\u202F":
      return " ";
    default:
      return ch;
  }
}

/** Length-preserving normalisation with a map back to raw offsets. */
function normaliseWithMap(source: string): { text: string; map: number[] } {
  const text: string[] = [];
  const map: number[] = [];
  let pendingSpace = false;
  let pendingIndex = 0;
  for (let i = 0; i < source.length; i++) {
    const raw = source[i];
    const ch = fold(raw.normalize("NFKC"));
    if (/\s/.test(ch)) {
      if (text.length > 0 && !pendingSpace) {
        pendingSpace = true;
        pendingIndex = i;
      }
      continue;
    }
    if (pendingSpace) {
      text.push(" ");
      map.push(pendingIndex);
      pendingSpace = false;
    }
    const lower = ch.toLowerCase();
    for (let k = 0; k < lower.length; k++) {
      text.push(lower[k]);
      map.push(i);
    }
  }
  return { text: text.join(""), map };
}

export function normalise(text: string): string {
  return normaliseWithMap(text).text.trim();
}

function lineAt(source: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < source.length; i++) if (source[i] === "\n") line++;
  return line;
}

function pageAt(source: string, offset: number): number {
  let page = 1;
  for (let i = 0; i < offset && i < source.length; i++) if (source[i] === "\f") page++;
  return page;
}

/** Verify that `quote` appears verbatim in `source`. */
export function verifyQuote(quote: string, source: string): QuoteCheck {
  const probe = quote.trim();
  if (probe.length === 0) {
    return { verified: false, match: "none", offset: null, line: null, occurrences: 0, reason: "empty quote" };
  }
  const normalisedProbe = normalise(probe);
  if (normalisedProbe.length < MIN_QUOTE) {
    return {
      verified: false,
      match: "none",
      offset: null,
      line: null,
      occurrences: 0,
      reason: `quote is shorter than ${MIN_QUOTE} characters and cannot be verified`,
    };
  }

  const exact = source.indexOf(probe);
  if (exact >= 0) {
    return {
      verified: true,
      match: "exact",
      offset: exact,
      line: lineAt(source, exact),
      occurrences: countOccurrences(source, probe),
    };
  }

  const { text, map } = normaliseWithMap(source);
  const hit = text.indexOf(normalisedProbe);
  if (hit < 0) {
    return { verified: false, match: "none", offset: null, line: null, occurrences: 0, reason: "not present in the source" };
  }
  const rawOffset = map[hit] ?? null;
  return {
    verified: true,
    match: "normalised",
    offset: rawOffset,
    line: rawOffset === null ? null : lineAt(source, rawOffset),
    occurrences: countOccurrences(text, normalisedProbe),
  };
}

function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(needle, from);
    if (at < 0) break;
    count++;
    from = at + needle.length;
    if (count >= 1000) break;
  }
  return count;
}

/** 1-based page for an offset, using form feeds as the page separator. */
export function pageOf(source: string, offset: number): number {
  return pageAt(source, offset);
}

export interface LocatedQuote {
  quote: string;
  verified: boolean;
  page: number | null;
  line: number | null;
}

/** Verify a quote and report where it sits, for the side-by-side table. */
export function locateQuote(quote: string, source: string): LocatedQuote {
  const check = verifyQuote(quote, source);
  return {
    quote,
    verified: check.verified,
    page: check.offset === null ? null : pageAt(source, check.offset),
    line: check.line,
  };
}

const QUOTE_PATTERN = /["\u201C]([^"\u201C\u201D]{20,400})["\u201D]/g;

/** Quoted strings inside a debrief finding, used to test recorded references. */
export function quotesIn(text: string): string[] {
  const out: string[] = [];
  for (const match of text.matchAll(QUOTE_PATTERN)) {
    const inner = (match[1] ?? "").trim();
    if (inner.length >= MIN_QUOTE) out.push(inner);
  }
  return out;
}

/** Split into trimmed sentences, keeping offsets so quotes map back. */
export function sentences(text: string): { text: string; offset: number }[] {
  const out: { text: string; offset: number }[] = [];
  const pattern = /[^.!?\n]+[.!?]?/g;
  for (const match of text.matchAll(pattern)) {
    const value = (match[0] ?? "").trim();
    if (value.length === 0) continue;
    out.push({ text: value, offset: match.index ?? 0 });
  }
  return out;
}

export function words(text: string): string[] {
  return normalise(text)
    .replace(/[^a-z0-9$%.\- ]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

const STOPWORDS = new Set(
  ("a an and are as at be been but by for from had has have in into is it its may not of on or our that the their there this to was were will with without " +
    "proposal offeror agency evaluation evaluator factor criteria criterion weakness deficiency strength significant however also which while shall should must " +
    "did does do was were been being such than then them they we you your").split(" "),
);

/** Distinctive terms of a finding, used to search the proposal. */
export function keyTerms(text: string, limit = 8): string[] {
  const counts = new Map<string, number>();
  for (const word of words(text)) {
    const w = word.replace(/^[-.]+|[-.]+$/g, "");
    if (w.length < 4 || STOPWORDS.has(w)) continue;
    counts.set(w, (counts.get(w) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || b[0].length - a[0].length)
    .slice(0, limit)
    .map(([w]) => w);
}

/** Best matching sentence in the source for a set of terms, or null. */
export function bestSentence(source: string, terms: string[], minHits = 1): string | null {
  if (terms.length === 0) return null;
  let best: { score: number; text: string } | null = null;
  const normalisedTerms = terms.map((t) => t.toLowerCase());
  for (const sentence of sentences(source)) {
    const lower = sentence.text.toLowerCase();
    let score = 0;
    for (const term of normalisedTerms) if (lower.includes(term)) score++;
    if (score >= minHits && (!best || score > best.score)) best = { score, text: sentence.text };
  }
  return best?.text ?? null;
}

export function countTermHits(source: string, terms: string[]): number {
  const lower = normalise(source);
  let hits = 0;
  for (const term of terms) if (lower.includes(term.toLowerCase())) hits++;
  return hits;
}

const NUMBER_PATTERN = /(\$)?\d[\d,]*(?:\.\d+)?\s*(thousand|million|billion|trillion|k|m|bn|%)?/gi;

function scaleOf(unit: string | undefined): number {
  switch ((unit ?? "").toLowerCase()) {
    case "thousand":
    case "k":
      return 1_000;
    case "million":
    case "m":
      return 1_000_000;
    case "billion":
    case "bn":
      return 1_000_000_000;
    case "trillion":
      return 1_000_000_000_000;
    default:
      return 1;
  }
}

/** Numeric values with their unit folded to a base number. */
export function numbersIn(text: string): number[] {
  const out: number[] = [];
  for (const match of text.matchAll(NUMBER_PATTERN)) {
    const raw = Number((match[0] ?? "").replace(/[^\d.]/g, ""));
    if (!Number.isFinite(raw)) continue;
    out.push(raw * scaleOf(match[2]));
  }
  return out;
}

/** True when every number in `claim` appears (exactly) in `source`. */
export function numbersAgree(claim: string, source: string): boolean {
  const sourceNumbers = new Set(numbersIn(source));
  const claimNumbers = numbersIn(claim);
  if (claimNumbers.length === 0) return true;
  return claimNumbers.every((n) => sourceNumbers.has(n));
}

const CROSS_REF = /\bsee\s+(?:section|§)\s+([A-Z0-9][A-Z0-9.\-]{0,8})/gi;

/**
 * Cross-references that do not resolve: "see Section 4" when no Section 4
 * exists in the proposal. Matches on a heading-like occurrence anywhere in the
 * document to stay conservative.
 */
export function unresolvedCrossReferences(source: string): string[] {
  const missing: string[] = [];
  const seen = new Set<string>();
  for (const match of source.matchAll(CROSS_REF)) {
    const id = (match[1] ?? "").replace(/\.$/, "");
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const pattern = new RegExp(`(^|\\n)\\s*(?:section\\s+|§\\s*)?${escapeRegExp(id)}(?![0-9A-Za-z])`, "i");
    if (!pattern.test(source)) missing.push(id);
  }
  return missing;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export interface ConcealedContent {
  kind: string;
  detail: string;
  severity: "critical" | "high" | "medium";
}

const ZERO_WIDTH = /[\u200B-\u200F\u2060\uFEFF\u202A-\u202E\u2066-\u2069]/;
const CONCEALMENT_PATTERNS: { kind: string; pattern: RegExp; detail: string; severity: ConcealedContent["severity"] }[] = [
  { kind: "white_text", pattern: /color\s*:\s*(?:#fff(?:fff)?|white|rgba?\(\s*255\s*,\s*255\s*,\s*255)/i, detail: "White or near-white text styling can hide content from a reader.", severity: "critical" },
  { kind: "zero_font", pattern: /font-size\s*:\s*0(?:px|em|rem|%)?/i, detail: "Zero font size hides text.", severity: "critical" },
  { kind: "hidden_element", pattern: /(?:display\s*:\s*none|visibility\s*:\s*hidden|opacity\s*:\s*0(?:\.0+)?\s*[;"\s])/i, detail: "Hidden element styling can conceal instructions.", severity: "critical" },
  { kind: "html_comment", pattern: /<!--[\s\S]{12,}?-->/i, detail: "HTML comments survive into some renderers and are invisible to a reader.", severity: "high" },
  { kind: "ai_instruction", pattern: /\b(?:ignore (?:all )?(?:previous|prior|above) instructions|you are an? (?:ai|evaluator|assistant)|as an ai (?:evaluator|model)|instruction to (?:the )?(?:ai|model|evaluator)|system prompt|prompt injection)\b/i, detail: "Text addressed to an AI evaluator rather than a human reader.", severity: "critical" },
  { kind: "evaluator_directive", pattern: /\b(?:rate (?:this|our) proposal|award (?:this|the) contract to|assign (?:a )?(?:highest|perfect) (?:rating|score)|score (?:this|us) (?:highest|maximum))\b/i, detail: "Directive aimed at steering an automated evaluation.", severity: "critical" },
  { kind: "encoded_payload", pattern: /\b[A-Za-z0-9+/]{180,}={0,2}\b/, detail: "A long encoded blob with no visible purpose.", severity: "medium" },
];

/**
 * Concealed or evaluator-addressed content. Quillon never generates any of
 * this (section 9 of the design), and flags it in uploaded drafts because
 * submitting it can disqualify an offeror.
 */
export function findConcealedContent(text: string): ConcealedContent[] {
  const found: ConcealedContent[] = [];
  const zero = ZERO_WIDTH.exec(text);
  if (zero) {
    found.push({
      kind: "zero_width",
      detail: `Zero-width or bidirectional control character U+${(zero[0].charCodeAt(0) ?? 0).toString(16).toUpperCase().padStart(4, "0")} at offset ${zero.index}.`,
      severity: "high",
    });
  }
  for (const rule of CONCEALMENT_PATTERNS) {
    const match = rule.pattern.exec(text);
    if (!match) continue;
    const offset = match.index ?? 0;
    const line = lineAt(text, offset);
    found.push({ kind: rule.kind, detail: `${rule.detail} First occurrence at line ${line}.`, severity: rule.severity });
  }
  return found;
}
