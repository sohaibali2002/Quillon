// Evaluator Twin: a simulated source selection board that reads a draft the
// way an unfriendly evaluator would.
//
// Independence is structural: each factor gets its own evaluator with only that
// factor's criteria and the proposal, and the consensus writer sees findings
// only after they are aggregated. Every finding must quote the proposal
// verbatim; a finding whose quote does not exist is discarded and logged. When
// no model provider is configured the panel still runs, as a deterministic
// rubric, and says so — it never pretends a model read the proposal.

import { generateText, Output } from "ai";
import { z } from "zod";
import { resolveModelAny } from "@/lib/models";
import { bestSentence, findConcealedContent, keyTerms, sentences, verifyQuote } from "./quote-check";
import { factorsOf } from "./rfp";
import { precedentsFor, type ProtestDecisionRecord } from "./corpus";
import {
  DISCLAIMER,
  FINDING_CLASSES,
  FINDING_RANK,
  type Criterion,
  type FindingClass,
  type Ground,
  type TwinFinding,
  type TwinReport,
} from "./types";

export const PANEL_ROLES = [
  { id: "factor", task: "Assess one evaluation factor against its stated criteria; cite proposal passages." },
  { id: "compliance", task: "Check every Section L instruction and shall-requirement for a response." },
  { id: "past_performance", task: "Assess relevancy (scope, size, complexity) and recency against stated definitions." },
  { id: "risk", task: "Identify proposal risk of unsuccessful performance, per stated criteria." },
  { id: "skeptic", task: "Adversarially look for deficiencies, unsupported claims and unclear passages." },
  { id: "consensus", task: "Merge findings into a draft evaluation report under the RFP's stated rating scheme." },
] as const;

const panelSchema = z.object({
  findings: z
    .array(
      z.object({
        class: z.enum(["strength", "weakness", "significant weakness", "deficiency"]),
        criterion_id: z.string().default(""),
        proposal_quote: z.string().default(""),
        reasoning: z.string().min(1),
        suggested_fix: z.string().min(1),
      }),
    )
    .max(12),
});

export interface TwinInput {
  proposal: string;
  criteria: Criterion[];
  rfp?: string;
  pastPerformance?: string;
  decisions?: ProtestDecisionRecord[];
  /** The RFP's own rating scheme. Ratings are never invented. */
  scheme?: string[];
  modelId?: string;
  maxFactors?: number;
}

const SUPERLATIVES = ["best-in-class", "world-class", "state of the art", "state-of-the-art", "unmatched", "unique", "seamless", "cutting-edge", "industry-leading", "superior", "innovative"];
const MITIGATION = /\b(?:plan|mitigat|backup|contingen|schedule|risk|fallback|escalat)\b/i;

/** The RFP's rating scheme, or none. An absent scheme means no ratings. */
export function schemeOf(rfp: string, explicit?: string[]): string[] {
  if (explicit && explicit.length > 0) return explicit.map((s) => s.toLowerCase());
  const lower = rfp.toLowerCase();
  if (/lowest price technically acceptable|\blpta\b/.test(lower)) return ["acceptable", "unacceptable"];
  if (/adjectival|outstanding/.test(lower) && /unacceptable/.test(lower)) return ["outstanding", "good", "acceptable", "marginal", "unacceptable"];
  if (/pass\/fail/.test(lower)) return ["pass", "fail"];
  if (/color|blue|purple|green|yellow|red/.test(lower)) return ["blue", "purple", "green", "yellow", "red"];
  return [];
}

function quoteOrNull(sentence: string | null, proposal: string): string {
  if (!sentence) return "";
  return verifyQuote(sentence, proposal).verified ? sentence : "";
}

function groundOf(cls: FindingClass, criterion: Criterion | null, text: string): Ground[] {
  const grounds = new Set<Ground>();
  if (/past performance/i.test(`${criterion?.factor ?? ""} ${text}`)) grounds.add("past_performance");
  if (/price|cost realism|unbalanced/i.test(text)) grounds.add("price_realism");
  if (/acceptable|material requirement/i.test(text)) grounds.add("acceptability");
  if (cls !== "strength") grounds.add("technical_evaluation");
  return [...grounds];
}

/**
 * The passages belonging to one factor: from a heading that names the factor to
 * the next heading, falling back to term matches when the draft has no such
 * heading. An evaluator reads a factor volume, not the whole proposal, so a
 * superlative outside the factor is not that factor's weakness.
 */
function factorSentences(proposal: string, factor: string): { text: string; offset: number }[] {
  const lines = proposal.split(/\r?\n/);
  const heading = (line: string) =>
    /^#{1,6}\s/.test(line.trim()) || /^\d+(?:\.\d+)*[.)]?\s+\S/.test(line.trim()) || /^[A-Z][A-Z0-9 &/,\-]{8,}$/.test(line.trim());
  const start = lines.findIndex((line) => heading(line) && line.toLowerCase().includes(factor.toLowerCase()));
  if (start >= 0) {
    let end = lines.length;
    for (let i = start + 1; i < lines.length; i++) {
      if (heading(lines[i])) {
        end = i;
        break;
      }
    }
    const section = lines.slice(start + 1, end).join("\n");
    if (section.trim().length > 0) return sentences(section);
  }
  const terms = keyTerms(factor, 6);
  return sentences(proposal).filter((s) => {
    const lower = s.text.toLowerCase();
    return terms.some((t) => lower.includes(t));
  });
}

/** Deterministic rubric: the panel's fallback and its sanity baseline. */
export function rubricFindings(input: TwinInput): TwinFinding[] {
  const findings: TwinFinding[] = [];
  const factors = factorsOf(input.criteria);
  let n = 0;
  const add = (factor: string, criterion: Criterion | null, cls: FindingClass, quote: string, reasoning: string, fix: string) => {
    if (findings.length >= 60) return;
    n++;
    findings.push({
      id: `TF-${n}`,
      factor,
      criterionId: criterion?.id ?? null,
      criterionText: criterion?.text ?? "",
      class: cls,
      proposalQuote: quote,
      quoteVerified: quote.length > 0 && verifyQuote(quote, input.proposal).verified,
      reasoning,
      suggestedFix: fix,
      groundRefs: groundOf(cls, criterion, reasoning),
      precedentRefs: [],
    });
  };

  for (const factor of factors) {
    const related = factorSentences(input.proposal, factor);
    const criterion = input.criteria.find((c) => c.factor === factor) ?? null;
    if (related.length === 0) {
      add(factor, criterion, "deficiency", "", `No passage of the proposal addresses the "${factor}" factor. An evaluator scoring this factor has nothing to assess.`, `Add a clearly labelled "${factor}" section that answers the factor as the RFP states it, with evidence references.`);
      continue;
    }
    const quantified = related.filter((s) => /\d/.test(s.text));
    if (quantified.length === 0) {
      const evidence = related.find((s) => s.text.length >= 40) ?? related[0];
      add(factor, criterion, "weakness", quoteOrNull(evidence?.text ?? null, input.proposal), `The "${factor}" narrative makes no measurable claim: no quantity, duration, percentage, date or price appears in the passages that address the factor.`, "State at least one measurable claim per discriminator (volume, cycle time, staffing, availability) and tie it to evidence.");
    }
    for (const sentence of related) {
      const lower = sentence.text.toLowerCase();
      if (SUPERLATIVES.some((word) => lower.includes(word)) && !/\d/.test(sentence.text)) {
        add(factor, criterion, "weakness", quoteOrNull(sentence.text, input.proposal), `Unsupported superlative in the "${factor}" response: the claim is an assertion without a measurable or evidenced basis.`, "Replace the assertion with a specific, verifiable claim and a reference to where the evidence sits.");
      }
    }
    for (const sentence of related) {
      if (/\bwe will\b/i.test(sentence.text) && !MITIGATION.test(sentence.text) && sentence.text.length > 60) {
        add(factor, criterion, "weakness", quoteOrNull(sentence.text, input.proposal), `A forward-looking commitment under "${factor}" has no stated plan, schedule or mitigation, which is proposal risk of unsuccessful performance.`, "Add the how, who, when and what-if: staffing, schedule, contingency and acceptance criteria.");
      }
    }
  }

  for (const instruction of input.criteria.filter((c) => c.kind === "instruction").slice(0, 12)) {
    const terms = keyTerms(instruction.text, 6);
    const hit = bestSentence(input.proposal, terms, 2);
    if (!hit) {
      add("Section L compliance", instruction, "deficiency", "", `No response was found to Section L instruction ${instruction.section}: "${instruction.text.slice(0, 160)}". A material instruction that is unanswered can make the proposal unacceptable.`, "Answer the instruction explicitly under a heading that repeats its wording.");
    }
  }

  return findings;
}

async function modelPanel(input: TwinInput): Promise<{ findings: TwinFinding[]; modelVersions: string[] } | null> {
  let model;
  try {
    model = await resolveModelAny(input.modelId);
  } catch {
    return null;
  }
  const factors = factorsOf(input.criteria).slice(0, Math.max(1, Math.min(8, input.maxFactors ?? 6)));
  if (factors.length === 0) return null;
  const modelVersions = new Set<string>();
  const findings: TwinFinding[] = [];
  let counter = 0;

  const results = await Promise.all(
    factors.map(async (factor) => {
      const criteria = input.criteria.filter((c) => c.factor === factor);
      const prompt = [
        `You are an independent source selection evaluator for one factor only: "${factor}".`,
        "Evaluate strictly against the criteria below. Use FAR 15.001 vocabulary: strength, weakness, significant weakness, deficiency.",
        "Every finding must quote the proposal verbatim in proposal_quote. If you cannot quote it, do not assert it.",
        "Be adversarial but fair: an unfriendly evaluator who must defend every finding on the record.",
        "",
        "Evaluation criteria:",
        criteria.map((c) => `- ${c.id} [${c.section}] ${c.text}`).join("\n"),
        "",
        "Proposal:",
        input.proposal.slice(0, 60_000),
      ].join("\n");
      try {
        const { output } = await generateText({
          model,
          output: Output.object({ schema: panelSchema }),
          prompt,
          temperature: 0.2,
        });
        return output.findings.map((f) => ({
          factor,
          criterionId: criteria.find((c) => c.id === f.criterion_id)?.id ?? criteria[0]?.id ?? null,
          criterionText: criteria.find((c) => c.id === f.criterion_id)?.text ?? criteria[0]?.text ?? "",
          class: f.class,
          proposalQuote: f.proposal_quote,
          reasoning: f.reasoning,
          suggestedFix: f.suggested_fix,
        }));
      } catch {
        return null;
      }
    }),
  );

  for (const result of results) {
    if (!result) continue;
    for (const finding of result) {
      counter++;
      findings.push({
        id: `TF-${counter}`,
        factor: finding.factor,
        criterionId: finding.criterionId,
        criterionText: finding.criterionText,
        class: finding.class,
        proposalQuote: finding.proposalQuote,
        quoteVerified: false,
        reasoning: finding.reasoning,
        suggestedFix: finding.suggestedFix,
        groundRefs: groundOf(finding.class, input.criteria.find((c) => c.id === finding.criterionId) ?? null, finding.reasoning),
        precedentRefs: [],
      });
    }
  }
  if (findings.length === 0) return null;
  if (typeof model === "string") modelVersions.add(model);
  else modelVersions.add(input.modelId ?? "configured-model");
  return { findings, modelVersions: [...modelVersions] };
}

/**
 * The quote gate. A finding that cites proposal text which does not exist is
 * discarded and logged — the same failure the module exists to catch when an
 * agency does it.
 */
export function gateFindings(findings: TwinFinding[], proposal: string): { kept: TwinFinding[]; discarded: TwinReport["discarded"] } {
  const kept: TwinFinding[] = [];
  const discarded: TwinReport["discarded"] = [];
  for (const finding of findings) {
    const quote = finding.proposalQuote.trim();
    if (quote.length === 0) {
      // An absence finding cannot quote what is not there; keep it, marked.
      kept.push({ ...finding, quoteVerified: false });
      continue;
    }
    const check = verifyQuote(quote, proposal);
    if (!check.verified) {
      discarded.push({ factor: finding.factor, class: finding.class, quote, reason: check.reason ?? "quote not found in the proposal" });
      continue;
    }
    kept.push({ ...finding, quoteVerified: true, proposalQuote: quote });
  }
  return { kept, discarded };
}

function ratingFor(findings: TwinFinding[], scheme: string[]): { rating: string | null; basis: string } {
  if (scheme.length === 0) return { rating: null, basis: "The RFP rating scheme was not supplied, so no rating is assigned." };
  const observed = findings.map((f) => f.class);
  if (observed.length === 0) return { rating: null, basis: "No findings were recorded for this factor." };
  const worst = observed.reduce((rank, cls) => Math.max(rank, FINDING_RANK[cls]), 0);
  const best = scheme[scheme.length - 1];
  const worstRating = scheme[0];
  const basis = `${observed.filter((c) => c === "strength").length} strength(s), ${observed.filter((c) => c === "weakness").length} weakness(es), ${observed.filter((c) => c === "significant weakness").length} significant weakness(es), ${observed.filter((c) => c === "deficiency").length} deficiency(ies) under the RFP's own scheme.`;
  if (worst >= 3) return { rating: worstRating ?? null, basis };
  if (worst === 2) return { rating: scheme[Math.min(scheme.length - 1, 1)] ?? null, basis };
  if (worst === 1) return { rating: scheme[Math.floor((scheme.length - 1) / 2)] ?? null, basis };
  return { rating: best ?? null, basis };
}

export interface TwinRunResult extends TwinReport {
  concealed: { kind: string; detail: string }[];
}

/** Run the panel and aggregate the report. */
export async function runTwin(input: TwinInput): Promise<TwinRunResult> {
  if (!input.proposal || input.proposal.trim().length < 200) {
    throw new Error("A proposal of at least 200 characters is required.");
  }
  const modelResult = await modelPanel(input);
  const base = modelResult?.findings ?? rubricFindings(input);
  const { kept, discarded } = gateFindings(base, input.proposal);

  for (const finding of kept) {
    const ground = finding.groundRefs[0];
    if (!ground || !input.decisions) continue;
    finding.precedentRefs = precedentsFor(ground, `${finding.reasoning} ${finding.factor}`, input.decisions, 2).map((hit) => ({
      decisionId: hit.decisionId,
      citation: hit.citation,
      url: hit.url,
    }));
  }

  const scheme = schemeOf(input.rfp ?? "", input.scheme);
  const factors = [...new Set(kept.map((f) => f.factor))];
  const ratings = factors.map((factor) => ({ factor, ...ratingFor(kept.filter((f) => f.factor === factor), scheme) }));

  return {
    mode: modelResult ? "model-panel" : "deterministic-rubric",
    modelVersions: modelResult?.modelVersions ?? [],
    findings: kept,
    discarded,
    ratings,
    scheme,
    factors,
    disclaimer:
      modelResult
        ? DISCLAIMER
        : `${DISCLAIMER} No model provider was configured, so this report is a deterministic rubric review, not a simulated model panel.`,
    created_at: new Date().toISOString(),
    concealed: findConcealedContent(input.proposal),
  };
}

export interface CalibrationObservation {
  factor: string;
  predicted: FindingClass;
  actual: FindingClass;
}

export interface CalibrationResult {
  factor: string;
  sample: number;
  exactMatches: number;
  nearMatches: number;
  agreement: number | null;
  note: string;
}

/** Back-test agreement per factor, with the sample size always visible. */
export function calibrate(observations: CalibrationObservation[]): CalibrationResult[] {
  const factors = [...new Set(observations.map((o) => o.factor))];
  return factors.map((factor) => {
    const rows = observations.filter((o) => o.factor === factor);
    const exact = rows.filter((r) => r.predicted === r.actual).length;
    const near = rows.filter((r) => Math.abs(FINDING_RANK[r.predicted] - FINDING_RANK[r.actual]) <= 1).length;
    return {
      factor,
      sample: rows.length,
      exactMatches: exact,
      nearMatches: near,
      agreement: rows.length === 0 ? null : Number((exact / rows.length).toFixed(2)),
      note: rows.length < 5 ? "Sample too small to interpret; report the count, not a rate." : "Exact-class agreement across the back-test.",
    };
  });
}

export function calibrationSummary(results: CalibrationResult[]): string {
  if (results.length === 0) return "No back-test observations recorded; no agreement figure is published.";
  return results
    .map((r) => `${r.factor}: ${r.exactMatches}/${r.sample} exact${r.sample < 5 ? " (sample too small to interpret)" : ""}`)
    .join(" · ");
}

export const TWIN_CLASSES = FINDING_CLASSES;
