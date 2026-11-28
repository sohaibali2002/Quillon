// Debrief Forensics: verify what the agency said against what the record shows.
//
// Pipeline per the design: atomize the debrief into discrete findings, trace
// each to a stated criterion, verify each claim about the proposal against the
// proposal text, check internal consistency, screen disparate treatment only
// where lawful comparable information exists, surface process-integrity
// indicators for counsel, map to grounds and precedent, and weight by
// record-based materiality. Nothing here predicts an outcome.

import {
  bestSentence,
  countTermHits,
  keyTerms,
  numbersAgree,
  quotesIn,
  sentences,
  verifyQuote,
} from "./quote-check";
import { precedentsFor, type PrecedentHit, type ProtestDecisionRecord } from "./corpus";
import {
  DISCLAIMER,
  FINDING_RANK,
  STANDARD_OF_REVIEW,
  type Criterion,
  type DebriefFindingRecord,
  type FindingClass,
  type ForensicsIssue,
  type ForensicsReport,
  type Ground,
  type Indicator,
  type Materiality,
  type Verification,
} from "./types";

export interface DebriefInput {
  proposal: string;
  debrief: string;
  criteria: Criterion[];
  awardeeExcerpts?: string;
  decisions?: ProtestDecisionRecord[];
  limitFindings?: number;
}

const CLASS_PATTERNS: [FindingClass, RegExp][] = [
  ["deficiency", /\bdeficien(?:cy|cies)\b/i],
  ["significant weakness", /\bsignificant weakness(?:es)?\b/i],
  ["weakness", /\bweakness(?:es)?\b|\bweak\b/i],
  ["strength", /\bstrength(?:s)?\b|\bstrong\b/i],
];

const ABSENCE = /\b(did not|does not|do not|failed to|failure to|no (?:evidence|discussion|detail|description|support)|omitted|lacks?|lacking|not (?:provided|included|addressed|demonstrated|described|identified))\b/i;
const NEGATIVE = /\b(lacks?|lacking|insufficient|limited|minimal|unclear|generic|vague|cursory|incomplete|superficial)\b/i;
const RATINGS = ["outstanding", "excellent", "good", "acceptable", "marginal", "unacceptable", "high", "moderate", "low", "pass", "fail"];

function classOf(text: string): FindingClass | null {
  for (const [cls, pattern] of CLASS_PATTERNS) if (pattern.test(text)) return cls;
  return null;
}

function normaliseFinding(text: string): string {
  return text.replace(/^[\s>*\-•\d.)]+/, "").replace(/\s+/g, " ").trim();
}

export function atomizeDebrief(text: string, limit = 200): { id: string; text: string; class: FindingClass; rationale: string }[] {
  const blocks: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.length === 0) {
      blocks.push("");
      continue;
    }
    const bullet = /^(?:[-*•]|\d+[.)]|[a-z][.)])\s+/i.test(line);
    if (bullet || blocks.length === 0) blocks.push(line);
    else blocks[blocks.length - 1] = `${blocks[blocks.length - 1]} ${line}`;
  }
  const out: { id: string; text: string; class: FindingClass; rationale: string }[] = [];
  for (const block of blocks) {
    const line = normaliseFinding(block);
    if (line.length < 30) continue;
    const cls = classOf(line);
    if (!cls) continue;
    if (out.length >= limit) break;
    out.push({ id: `DF-${out.length + 1}`, text: line, class: cls, rationale: line });
  }
  return out;
}

function traceCriterion(text: string, criteria: Criterion[]): Criterion | null {
  const sectionRef = /\b(?:section|factor|subfactor)\s+([A-Z]?\d+(?:\.\d+)*)/i.exec(text);
  if (sectionRef?.[1]) {
    const id = sectionRef[1];
    const hit = criteria.find((c) => c.section.endsWith(id) || c.id.endsWith(id));
    if (hit) return hit;
  }
  const lower = text.toLowerCase();
  let best: { criterion: Criterion; score: number } | null = null;
  for (const criterion of criteria) {
    const terms = keyTerms(`${criterion.factor} ${criterion.text}`, 8);
    let score = 0;
    for (const term of terms) if (lower.includes(term)) score++;
    if (lower.includes(criterion.factor.toLowerCase()) && criterion.factor.length > 4) score += 2;
    if (!best || score > best.score) best = { criterion, score };
  }
  return best && best.score >= 2 ? best.criterion : null;
}

interface VerifiedClaim {
  verification: Verification;
  quote: string | null;
  quoteVerified: boolean;
  detail: string;
  indicators: Indicator[];
  discardedQuote: string | null;
}

export function verifyClaim(findingText: string, proposal: string, criterion: Criterion | null): VerifiedClaim {
  const indicators: Indicator[] = [];
  const quoted = quotesIn(findingText);
  let verifiedQuote: string | null = null;
  let discardedQuote: string | null = null;

  for (const quote of quoted) {
    const check = verifyQuote(quote, proposal);
    if (check.verified) verifiedQuote = quote;
    else {
      discardedQuote = quote;
      indicators.push({
        kind: "nonexistent_quote",
        label: "Quotes proposal content that does not exist",
        detail: `The debrief quotes "${quote.slice(0, 120)}" but that text does not appear in this offeror's proposal.`,
      });
    }
  }

  const terms = keyTerms(findingText.replace(criterion?.text ?? "", ""), 8);
  const hits = countTermHits(proposal, terms);
  const absence = ABSENCE.test(findingText);
  const negative = absence || NEGATIVE.test(findingText);
  const support = bestSentence(proposal, terms, 2);

  if (verifiedQuote) {
    return { verification: "supported", quote: verifiedQuote, quoteVerified: true, detail: "The debrief quotes text that exists in the proposal.", indicators, discardedQuote };
  }
  if (absence) {
    if (support) {
      return { verification: "contradicted", quote: support, quoteVerified: true, detail: "The debrief says the proposal did not address this, but the proposal addresses it.", indicators, discardedQuote };
    }
    if (hits >= 3) {
      const single = bestSentence(proposal, terms, 1);
      return { verification: "contradicted", quote: single, quoteVerified: Boolean(single), detail: "Terms specific to the finding appear repeatedly in the proposal, so the stated omission is doubtful.", indicators, discardedQuote };
    }
    return { verification: "absent", quote: null, quoteVerified: false, detail: "The proposal does not address the point either, which is consistent with the finding.", indicators, discardedQuote };
  }
  if (support) {
    return { verification: "supported", quote: support, quoteVerified: true, detail: "The proposal contains a passage matching the finding.", indicators, discardedQuote };
  }
  if (hits >= 2) {
    return { verification: "ambiguous", quote: null, quoteVerified: false, detail: "Related terms appear, but no single passage supports the finding as stated.", indicators, discardedQuote };
  }
  if (negative) {
    return { verification: "absent", quote: null, quoteVerified: false, detail: "Nothing in the proposal supports the negative characterisation, and the proposal does not address the point.", indicators, discardedQuote };
  }
  return { verification: "ambiguous", quote: null, quoteVerified: false, detail: "No passage in the proposal supports or refutes the finding as written.", indicators, discardedQuote };
}

function materialityOf(verification: Verification, cls: FindingClass, criterion: Criterion | null): Materiality {
  const weight = FINDING_RANK[cls];
  if (verification === "contradicted" && weight >= 2) return "high";
  if (verification === "contradicted" && weight === 1) return criterion?.kind === "factor" ? "high" : "medium";
  if (verification === "ambiguous" && weight >= 2) return "medium";
  if (verification === "contradicted") return "medium";
  if (verification === "supported" && weight >= 2) return "medium";
  return "low";
}

function groundsFor(text: string, verification: Verification, criterion: Criterion | null, indicators: Indicator[]): Ground[] {
  const grounds = new Set<Ground>();
  if (!criterion) grounds.add("unstated_criteria");
  if (verification === "contradicted") grounds.add("technical_evaluation");
  if (indicators.some((i) => i.kind === "nonexistent_quote")) grounds.add("technical_evaluation");
  if (/past performance/i.test(text)) grounds.add("past_performance");
  if (/price|cost/i.test(text)) grounds.add("price_realism");
  if (/discussion|clarification|final proposal revision/i.test(text)) grounds.add("discussions");
  if (/best value|trade-?off/i.test(text)) grounds.add("best_value_tradeoff");
  if (/organizational conflict|\boci\b/i.test(text)) grounds.add("organizational_conflict");
  if (/unacceptable|not acceptable|material requirement/i.test(text)) grounds.add("acceptability");
  if (/disparate|unequal treatment|treated differently/i.test(text)) grounds.add("disparate_treatment");
  return [...grounds];
}

function suggestedQuestions(indicators: Indicator[], verification: Verification): string[] {
  const questions: string[] = [];
  if (indicators.some((i) => i.kind === "nonexistent_quote")) {
    questions.push("Which page of our proposal was the quoted language taken from, and may we see the evaluator worksheet behind it?");
    questions.push("Were proposal-specific analytic reports or automated summaries generated during the evaluation, and by whom?");
  }
  if (indicators.some((i) => i.kind === "boilerplate")) {
    questions.push("Were the same rationale templates used across offerors or factors?");
  }
  if (verification === "contradicted") {
    questions.push("Which part of the evaluation record supports the finding given the passage in our proposal?");
  }
  return questions;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const value of a) if (b.has(value)) intersection++;
  return intersection / (a.size + b.size - intersection);
}

function consistencyChecks(
  findings: DebriefFindingRecord[],
  debrief: string,
  proposal: string,
  criteria: Criterion[],
): { kind: string; detail: string }[] {
  const issues: { kind: string; detail: string }[] = [];
  const factorOf = new Map(criteria.map((c) => [c.id, c.factor]));

  // Rating versus reasoning: a high rating with a deficiency recorded.
  const ratingPattern = new RegExp(`([A-Za-z][A-Za-z /\\-]{2,60}?)\\s*[:\\-–]\\s*(${RATINGS.join("|")})\\b`, "gi");
  for (const match of debrief.matchAll(ratingPattern)) {
    const factor = (match[1] ?? "").trim();
    const rating = (match[2] ?? "").toLowerCase();
    const strong = ["outstanding", "excellent", "good", "acceptable", "high", "pass"].includes(rating);
    if (!strong) continue;
    const related = findings.filter(
      (f) =>
        f.class !== "strength" &&
        factor.length > 3 &&
        ((f.criterionId ? factorOf.get(f.criterionId)?.toLowerCase() === factor.toLowerCase() : false) ||
          f.text.toLowerCase().includes(factor.toLowerCase())),
    );
    const severe = related.filter((f) => FINDING_RANK[f.class] >= 2);
    if (severe.length > 0) {
      issues.push({
        kind: "rating_reasoning",
        detail: `Factor "${factor}" is rated ${rating}, yet the debrief records ${severe.length} finding(s) at significant-weakness or deficiency level under it.`,
      });
    }
  }

  // Same feature earning a strength in one factor and a weakness in another.
  const strengthSets = findings.filter((f) => f.class === "strength");
  const weaknessSets = findings.filter((f) => f.class !== "strength");
  for (const strength of strengthSets) {
    const sTerms = new Set(keyTerms(strength.text, 10));
    for (const weakness of weaknessSets) {
      const wTerms = new Set(keyTerms(weakness.text, 10));
      if (jaccard(sTerms, wTerms) >= 0.45) {
        issues.push({
          kind: "cross_factor",
          detail: `The same feature appears as a strength ("${strength.text.slice(0, 80)}") and as a ${weakness.class} ("${weakness.text.slice(0, 80)}").`,
        });
      }
    }
  }

  // Numbers in a finding that the proposal does not contain.
  for (const finding of findings) {
    if (!numbersAgree(finding.text, proposal) && /\d/.test(finding.text)) {
      issues.push({
        kind: "numeric",
        detail: `Finding "${finding.text.slice(0, 90)}" states a figure that does not appear in the proposal; verify the price or quantity against the submitted volume.`,
      });
    }
  }

  // Boilerplate rationale across findings.
  const sets = findings.map((f) => new Set(keyTerms(f.text, 12)));
  for (let i = 0; i < sets.length; i++) {
    for (let j = i + 1; j < sets.length; j++) {
      if (jaccard(sets[i], sets[j]) >= 0.8 && findings[i].class === findings[j].class) {
        findings[i].indicators.push({ kind: "boilerplate", label: "Formulaic rationale", detail: "Near-identical rationale to another finding; a counsel indicator, not proof of automation." });
        findings[j].indicators.push({ kind: "boilerplate", label: "Formulaic rationale", detail: "Near-identical rationale to another finding; a counsel indicator, not proof of automation." });
      }
    }
  }

  return issues;
}

function disparateTreatment(findings: DebriefFindingRecord[], awardeeExcerpts?: string): { assessed: boolean; reason: string } {
  if (!awardeeExcerpts || awardeeExcerpts.trim().length < 40) {
    return {
      assessed: false,
      reason: "No lawfully held awardee excerpts were supplied, so disparate treatment cannot be assessed. The module does not infer it.",
    };
  }
  const overlaps = findings.filter((f) => {
    const terms = keyTerms(f.text, 6);
    return terms.length > 0 && countTermHits(awardeeExcerpts, terms) >= 2;
  });
  return {
    assessed: true,
    reason:
      overlaps.length === 0
        ? "Awardee excerpts were supplied but no comparable feature overlap was detected; a human comparison is still required."
        : `${overlaps.length} finding(s) describe features that also appear in the awardee excerpts; compare the treatment recorded for each before asserting disparate treatment.`,
  };
}

function precedentRefs(grounds: Ground[], query: string, decisions?: ProtestDecisionRecord[]): PrecedentHit[] {
  if (!decisions || decisions.length === 0) return [];
  const hits: PrecedentHit[] = [];
  for (const ground of grounds) hits.push(...precedentsFor(ground, query, decisions, 2));
  const seen = new Set<string>();
  return hits.filter((h) => (seen.has(h.decisionId) ? false : (seen.add(h.decisionId), true))).slice(0, 4);
}

/**
 * Full debrief analysis. Deterministic and replayable: the same documents
 * produce the same verification table, and every quote shown exists in the
 * source it is attributed to.
 */
export function analyseDebrief(input: DebriefInput): ForensicsReport {
  const raw = atomizeDebrief(input.debrief, input.limitFindings);
  const findings: DebriefFindingRecord[] = [];
  const issues: ForensicsIssue[] = [];
  const discardedQuotes: { findingId: string; quote: string }[] = [];

  for (const item of raw) {
    const criterion = traceCriterion(item.text, input.criteria);
    const claim = verifyClaim(item.text, input.proposal, criterion);
    if (claim.discardedQuote) discardedQuotes.push({ findingId: item.id, quote: claim.discardedQuote });
    const indicators = [...claim.indicators];
    if (!criterion) {
      indicators.push({
        kind: "no_criterion",
        label: "No stated criterion",
        detail: "This finding maps to no evaluation factor, subfactor or instruction in the solicitation as supplied. Check the RFP and amendments before asserting an unstated-criteria ground.",
      });
    }
    if (claim.verification === "contradicted") {
      indicators.push({
        kind: "misses_record",
        label: "Rationale misses material in the proposal",
        detail: claim.detail,
      });
    }
    const grounds = groundsFor(item.text, claim.verification, criterion, indicators);
    const materiality = materialityOf(claim.verification, item.class, criterion);

    const finding: DebriefFindingRecord = {
      id: item.id,
      text: item.text,
      class: item.class,
      rationale: item.rationale,
      criterionId: criterion?.id ?? null,
      criterionText: criterion?.text ?? null,
      verification: claim.verification,
      proposalQuote: claim.quote,
      quoteVerified: claim.quoteVerified,
      indicators,
      groundRefs: grounds,
      materiality,
      suggestedQuestions: suggestedQuestions(indicators, claim.verification),
    };
    findings.push(finding);

    const precedent = precedentRefs(grounds.slice(0, 2), item.text, input.decisions);
    issues.push({
      findingId: finding.id,
      summary: `${item.class} — ${claim.detail}`,
      grounds,
      materiality,
      precedentRefs: precedent.map((p) => ({ decisionId: p.decisionId, citation: p.citation, url: p.url })),
    });
  }

  const consistency = consistencyChecks(findings, input.debrief, input.proposal, input.criteria);
  for (const finding of findings) {
    if (finding.verification === "contradicted") {
      finding.suggestedQuestions = [...new Set([...finding.suggestedQuestions, ...suggestedQuestions(finding.indicators, finding.verification)])];
    }
  }

  const order: Record<Materiality, number> = { high: 0, medium: 1, low: 2 };
  issues.sort((a, b) => order[a.materiality] - order[b.materiality] || a.findingId.localeCompare(b.findingId));

  const count = (v: Verification) => findings.filter((f) => f.verification === v).length;
  const summary = [
    `${findings.length} finding(s) atomized from the debrief.`,
    `${count("contradicted")} contradicted by the proposal, ${count("supported")} supported, ${count("absent")} consistent with an omission, ${count("ambiguous")} needing a human read.`,
    `${issues.filter((i) => i.materiality === "high").length} issue(s) are high materiality on the record.`,
    discardedQuotes.length > 0
      ? `${discardedQuotes.length} quoted passage(s) attributed to the proposal do not exist in it; they are listed for counsel and never shown as proposal text.`
      : "Every quote attributed to the proposal was found verbatim.",
    consistency.length > 0 ? `${consistency.length} internal consistency issue(s) were detected.` : "No internal consistency issue was detected.",
  ];

  return {
    findings,
    issues,
    consistency,
    disparateTreatment: disparateTreatment(findings, input.awardeeExcerpts),
    discardedQuotes,
    summary,
    disclaimer: DISCLAIMER,
    standardOfReview: STANDARD_OF_REVIEW,
    created_at: new Date().toISOString(),
  };
}
