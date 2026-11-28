// Evaluation Forensics: shared vocabulary.
//
// Two surfaces share these types: the Evaluator Twin (pre-submission simulated
// source selection) and Debrief Forensics (post-award verification of the
// agency's findings). Both speak FAR Part 15 vocabulary and the same protest
// ground taxonomy, so a finding a user marks in one place means the same thing
// in the other and in the precedent corpus.

export const GROUNDS = [
  "unstated_criteria",
  "disparate_treatment",
  "evaluation_scheme",
  "technical_evaluation",
  "past_performance",
  "price_realism",
  "discussions",
  "best_value_tradeoff",
  "organizational_conflict",
  "acceptability",
  "timeliness",
] as const;

export type Ground = (typeof GROUNDS)[number];

export const GROUND_LABELS: Record<Ground, string> = {
  unstated_criteria: "Unstated evaluation criteria",
  disparate_treatment: "Disparate treatment of offerors",
  evaluation_scheme: "Failure to follow the stated evaluation scheme",
  technical_evaluation: "Unreasonable or undocumented technical evaluation",
  past_performance: "Past performance relevancy and recency errors",
  price_realism: "Flawed price or cost realism evaluation",
  discussions: "Improper or unequal discussions",
  best_value_tradeoff: "Unreasonable best-value tradeoff",
  organizational_conflict: "Organizational conflict of interest",
  acceptability: "Proposal acceptability (awardee failed a material requirement)",
  timeliness: "Procedural and timeliness defects",
};

// Distinctive terms that tie a fact pattern to a ground. Used only for
// retrieval and suggestion; a human decides whether a ground applies.
export const GROUND_KEYWORDS: Record<Ground, string[]> = {
  unstated_criteria: ["not stated", "not disclosed", "unstated", "not in the solicitation", "not required by the rfp", "criterion not", "did not require"],
  disparate_treatment: ["disparate", "unequal treatment", "inconsistent treatment", "treated differently", "similarly situated"],
  evaluation_scheme: ["stated evaluation", "evaluation scheme", "relative importance", "not follow", "failed to evaluate", "subfactor"],
  technical_evaluation: ["unreasonable", "not supported by the record", "undocumented", "irrational", "without explanation", "not documented"],
  past_performance: ["past performance", "relevancy", "recency", "not relevant", "similar scope", "cpars"],
  price_realism: ["price realism", "cost realism", "unbalanced", "price evaluation", "cost analysis", "price reasonableness"],
  discussions: ["discussions", "clarifications", "meaningful discussions", "unequal discussions", "final proposal revision"],
  best_value_tradeoff: ["best value", "tradeoff", "trade-off", "technically superior", "higher rated", "price premium"],
  organizational_conflict: ["organizational conflict", "oci", "conflict of interest", "mitigation plan"],
  acceptability: ["acceptable", "unacceptable", "material requirement", "failed to meet", "technically unacceptable"],
  timeliness: ["timely", "untimely", "dismissed as", "filing deadline", "protest was filed"],
};

export const FINDING_CLASSES = ["strength", "weakness", "significant weakness", "deficiency"] as const;
export type FindingClass = (typeof FINDING_CLASSES)[number];

export const FINDING_RANK: Record<FindingClass, number> = {
  strength: 0,
  weakness: 1,
  "significant weakness": 2,
  deficiency: 3,
};

export const VERIFICATIONS = ["supported", "contradicted", "absent", "ambiguous"] as const;
export type Verification = (typeof VERIFICATIONS)[number];

export const VERIFICATION_LABELS: Record<Verification, string> = {
  supported: "Supported by the proposal",
  contradicted: "Contradicted by the proposal",
  absent: "Absent from the proposal (consistent with the finding)",
  ambiguous: "Ambiguous — needs a human read",
};

export type Materiality = "high" | "medium" | "low";

export interface Criterion {
  id: string;
  /** The evaluation factor (for example "Technical Approach"). */
  factor: string;
  /** Section L instruction or Section M factor/subfactor. */
  section: string;
  text: string;
  kind: "factor" | "subfactor" | "instruction" | "shall";
}

export interface QuoteCheck {
  verified: boolean;
  match: "exact" | "normalised" | "none";
  offset: number | null;
  line: number | null;
  occurrences: number;
  reason?: string;
}

export interface TwinFinding {
  id: string;
  factor: string;
  criterionId: string | null;
  criterionText: string;
  class: FindingClass;
  proposalQuote: string;
  quoteVerified: boolean;
  reasoning: string;
  suggestedFix: string;
  groundRefs: Ground[];
  precedentRefs: { decisionId: string; citation: string; url: string }[];
}

export interface TwinReport {
  mode: "model-panel" | "deterministic-rubric";
  modelVersions: string[];
  findings: TwinFinding[];
  discarded: { factor: string; class: FindingClass; quote: string; reason: string }[];
  ratings: { factor: string; rating: string | null; basis: string }[];
  scheme: string[];
  factors: string[];
  disclaimer: string;
  created_at: string;
}

export interface DebriefFindingRecord {
  id: string;
  text: string;
  class: FindingClass;
  rationale: string;
  criterionId: string | null;
  criterionText: string | null;
  verification: Verification;
  proposalQuote: string | null;
  quoteVerified: boolean;
  indicators: Indicator[];
  groundRefs: Ground[];
  materiality: Materiality;
  suggestedQuestions: string[];
}

export interface Indicator {
  kind: "nonexistent_quote" | "boilerplate" | "misses_record" | "no_criterion";
  label: string;
  detail: string;
}

export interface ForensicsIssue {
  findingId: string;
  summary: string;
  grounds: Ground[];
  materiality: Materiality;
  precedentRefs: { decisionId: string; citation: string; url: string }[];
}

export interface ForensicsReport {
  findings: DebriefFindingRecord[];
  issues: ForensicsIssue[];
  consistency: { kind: string; detail: string }[];
  disparateTreatment: { assessed: boolean; reason: string };
  discardedQuotes: { findingId: string; quote: string }[];
  summary: string[];
  disclaimer: string;
  standardOfReview: string;
  created_at: string;
}

export interface DecisionPassage {
  field: string;
  passage: string;
  offset: number;
}

export interface DecisionGround {
  ground: Ground;
  holding: "sustained" | "denied" | "dismissed" | "academic" | "unknown";
  standard: string;
  passage: string;
}

export interface ExtractedDecision {
  tribunal: "GAO" | "COFC" | "unknown";
  docket: string;
  decisionDate: string;
  agency: string;
  solicitationType: string;
  scheme: string;
  outcome: "sustained" | "denied" | "dismissed" | "unknown";
  factors: string[];
  grounds: DecisionGround[];
  remedy: string;
  passages: DecisionPassage[];
}

export const DISCLAIMER =
  "Not legal advice. Every finding is record-based analysis for counsel to review; deadlines and protest grounds must be verified with procurement counsel before relying on them. No win probability is estimated.";

export const STANDARD_OF_REVIEW =
  "Tribunals review whether an evaluation was reasonable and consistent with the solicitation and will not substitute their judgment for the agency's technical judgment. Issues here are weighted by whether they are record-based and material, not by disagreement with technical judgment.";

export const CLOCK_DISCLAIMER =
  "Deadline rules change and have exceptions. Every computed date is marked verify-with-counsel and is never presented as authoritative.";
