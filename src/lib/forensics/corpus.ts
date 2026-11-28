// Protest Intelligence corpus.
//
// Published GAO and Court of Federal Claims decisions become structured
// records: parties, agency, evaluation scheme, grounds with the tribunal's
// holding and the standard applied, remedy, and every field linked back to the
// passage it came from. Retrieval is hybrid: metadata filters first, then a
// lexical BM25 score over the holding, the passage and the full text.
//
// Two rules the retrieval surface may never break: every hit carries its
// citation and a link, and nothing is returned without a passage a reader can
// check.

import { GROUNDS, type ExtractedDecision, type Ground, type DecisionGround } from "./types";
import { sentences } from "./quote-check";

export const EXTRACTION_VERSION = "1.0.0";

const TRIBUNALS = ["GAO", "COFC", "unknown"] as const;
type Tribunal = (typeof TRIBUNALS)[number];

const MONTHS = "January|February|March|April|May|June|July|August|September|October|November|December";

export interface DecisionMeta {
  citation?: string;
  url?: string;
  tribunal?: Tribunal;
  agency?: string;
  decisionDate?: string;
}

export interface ProtestDecisionRecord {
  id: string;
  tribunal: Tribunal;
  docket: string;
  decisionDate: string;
  agency: string;
  citation: string;
  url: string;
  outcome: "sustained" | "denied" | "dismissed" | "unknown";
  text: string;
  extracted: ExtractedDecision;
  extractionVersion: string;
}

function findPassage(text: string, index: number): { sentence: string; offset: number } | null {
  if (index < 0) return null;
  let offset = 0;
  for (const sentence of sentences(text)) {
    offset = sentence.offset;
    if (sentence.offset <= index && index < sentence.offset + sentence.text.length) return { sentence: sentence.text, offset: sentence.offset };
  }
  const first = sentences(text)[0];
  return first ? { sentence: first.text, offset } : null;
}

function detectTribunal(text: string, meta: DecisionMeta): Tribunal {
  if (meta.tribunal && TRIBUNALS.includes(meta.tribunal)) return meta.tribunal;
  if (/court of federal claims/i.test(text)) return "COFC";
  if (/government accountability office|comptroller general/i.test(text) || /B-\d{6,}/.test(text)) return "GAO";
  return "unknown";
}

function detectDocket(text: string): string {
  const gao = /\bB-\d{6,7}(?:\.\d+)?\b/.exec(text);
  if (gao) return gao[0];
  const cofc = /\b(?:No\.|Case No\.)\s*(\d{2}-\d{3}[A-Z]?)\b/i.exec(text);
  return cofc?.[1] ?? "";
}

function detectDate(text: string, meta: DecisionMeta): string {
  if (meta.decisionDate && /^\d{4}-\d{2}-\d{2}$/.test(meta.decisionDate)) return meta.decisionDate;
  const match = new RegExp(`\\b(?:${MONTHS})\\s+\\d{1,2},\\s+(?:19|20)\\d{2}\\b`).exec(text);
  if (!match) return "";
  const date = new Date(match[0]);
  return Number.isNaN(date.getTime()) ? "" : date.toISOString().slice(0, 10);
}

function detectAgency(text: string, meta: DecisionMeta): string {
  if (meta.agency) return meta.agency;
  const department = /\bDepartment of (?:the )?[A-Z][A-Za-z]+(?: [A-Z][A-Za-z]+)?/.exec(text);
  if (department) return department[0];
  const agency = /\b(?:Defense Logistics Agency|General Services Administration|National Aeronautics and Space Administration|Department of Defense|Department of Homeland Security|Veterans Affairs|Internal Revenue Service|Federal Bureau of Investigation)\b/.exec(text);
  return agency?.[0] ?? "unknown";
}

function detectOutcome(text: string): "sustained" | "denied" | "dismissed" | "unknown" {
  const tail = sentences(text).slice(-40).map((s) => s.text.toLowerCase()).join(" ");
  const sustain = (tail.match(/\bsustain(?:ed|s)?\b/g) ?? []).length;
  const deny = (tail.match(/\bden(?:y|ied|ies)\b/g) ?? []).length;
  const dismiss = (tail.match(/\bdismiss(?:ed|es)?\b/g) ?? []).length;
  if (dismiss > sustain && dismiss > deny) return "dismissed";
  if (sustain > deny) return "sustained";
  if (deny > 0) return "denied";
  return "unknown";
}

function holdingNear(text: string, index: number): DecisionGround["holding"] {
  const window = text.slice(Math.max(0, index - 800), Math.min(text.length, index + 800)).toLowerCase();
  if (/\bdismiss/.test(window)) return "dismissed";
  if (/\bsustain/.test(window)) return "sustained";
  if (/\bden(y|ied|ies)\b/.test(window)) return "denied";
  if (/\bacademic|we need not (?:address|consider)/.test(window)) return "academic";
  return "unknown";
}

function detectStandard(text: string): string {
  const lower = text.toLowerCase();
  if (/abuse of discretion/.test(lower)) return "Abuse of discretion";
  if (/not substitute (?:our|its) judgment/.test(lower)) return "Reasonableness; tribunal does not substitute its judgment";
  if (/reasonable basis|rational basis/.test(lower)) return "Reasonable basis in the record";
  if (/documentation|well[- ]documented/.test(lower)) return "Documentation sufficiency";
  return "Reasonableness and consistency with the solicitation";
}

const FACTOR_HINT = /(?:evaluation factors?|factors? (?:are|were|include))([^.]{10,400})\./i;

function detectFactors(text: string): string[] {
  const match = FACTOR_HINT.exec(text);
  if (!match?.[1]) return [];
  return match[1]
    .split(/;|,|\band\b/)
    .map((f) => f.replace(/^\s*(?:the|a|an)\s+/i, "").trim())
    .filter((f) => f.length >= 3 && f.length <= 60)
    .slice(0, 8);
}

function detectScheme(text: string): string {
  const lower = text.toLowerCase();
  if (/lowest price technically acceptable|\blpta\b/.test(lower)) return "LPTA";
  if (/best value tradeoff|best-value tradeoff|trade-?off process/.test(lower)) return "Best value tradeoff";
  if (/adjectival|outstanding|good|acceptable|marginal|unacceptable/.test(lower)) return "Adjectival ratings";
  if (/color (?:rating|scheme)|blue|purple|green|yellow|red/.test(lower)) return "Color ratings";
  if (/pass\/fail|acceptable\/unacceptable/.test(lower)) return "Pass/fail";
  return "unknown";
}

const SOLICITATION_TYPES: [RegExp, string][] = [
  [/request for proposals|\brfp\b/i, "RFP"],
  [/request for quotations|\brfq\b/i, "RFQ"],
  [/invitation for bids|\bifb\b/i, "IFB"],
  [/task order|delivery order/i, "Task/delivery order"],
  [/request for information|\brfi\b/i, "RFI"],
];

function detectSolicitationType(text: string): string {
  for (const [pattern, label] of SOLICITATION_TYPES) if (pattern.test(text)) return label;
  return "unknown";
}

function detectRemedy(text: string): string {
  const match = /\b(?:we recommend|recommend(?:ed)? that the agency|the agency (?:shall|must) (?:reconsider|reevaluate|reimburse))([^.]{5,300})\./i.exec(text);
  return match ? `${match[0].trim()}`.slice(0, 400) : "";
}

function detectGrounds(text: string, keywords: Record<Ground, string[]>): DecisionGround[] {
  const out: DecisionGround[] = [];
  const lower = text.toLowerCase();
  for (const ground of GROUNDS) {
    let firstIndex = -1;
    for (const keyword of keywords[ground]) {
      const at = lower.indexOf(keyword);
      if (at >= 0 && (firstIndex < 0 || at < firstIndex)) firstIndex = at;
    }
    if (firstIndex < 0) continue;
    const passage = findPassage(text, firstIndex);
    if (!passage) continue;
    out.push({
      ground,
      holding: holdingNear(text, firstIndex),
      standard: detectStandard(text),
      passage: passage.sentence.slice(0, 600),
    });
  }
  return out;
}

/**
 * Deterministic extraction. Every extracted field keeps the passage it came
 * from, so a reviewer can check the machine's read against the decision and a
 * re-extraction with a newer version is auditable.
 */
export function extractDecision(text: string, meta: DecisionMeta = {}, keywords: Record<Ground, string[]>): ExtractedDecision {
  const tribunal = detectTribunal(text, meta);
  const docket = detectDocket(text);
  const decisionDate = detectDate(text, meta);
  const agency = detectAgency(text, meta);
  const outcome = detectOutcome(text);
  const grounds = detectGrounds(text, keywords);
  const passages: ExtractedDecision["passages"] = [];
  const agencyIndex = agency === "unknown" ? -1 : text.indexOf(agency);
  const agencyPassage = findPassage(text, agencyIndex);
  if (agencyPassage) passages.push({ field: "agency", passage: agencyPassage.sentence.slice(0, 400), offset: agencyPassage.offset });
  for (const ground of grounds) passages.push({ field: `ground:${ground.ground}`, passage: ground.passage, offset: 0 });
  return {
    tribunal,
    docket,
    decisionDate,
    agency,
    solicitationType: detectSolicitationType(text),
    scheme: detectScheme(text),
    outcome,
    factors: detectFactors(text),
    grounds,
    remedy: detectRemedy(text),
    passages,
  };
}

export function parseDecision(
  id: string,
  text: string,
  meta: DecisionMeta,
  keywords: Record<Ground, string[]>,
): ProtestDecisionRecord {
  const extracted = extractDecision(text, meta, keywords);
  const citation = meta.citation?.trim() || [extracted.tribunal === "unknown" ? "Decision" : extracted.tribunal, extracted.docket].filter(Boolean).join(" ");
  return {
    id,
    tribunal: extracted.tribunal,
    docket: extracted.docket,
    decisionDate: extracted.decisionDate,
    agency: extracted.agency,
    citation: citation || `Decision ${id}`,
    url: meta.url ?? "",
    outcome: extracted.outcome,
    text,
    extracted,
    extractionVersion: EXTRACTION_VERSION,
  };
}

export interface CorpusFilters {
  ground?: Ground;
  agency?: string;
  outcome?: ProtestDecisionRecord["outcome"];
  year?: number;
  tribunal?: Tribunal;
  limit?: number;
}

export interface PrecedentHit {
  decisionId: string;
  citation: string;
  url: string;
  tribunal: Tribunal;
  decisionDate: string;
  agency: string;
  outcome: ProtestDecisionRecord["outcome"];
  ground: Ground | null;
  holding: DecisionGround["holding"];
  standard: string;
  passage: string;
  score: number;
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 2);
}

function bm25(docs: string[][], query: string[], k1 = 1.4, b = 0.75): number[] {
  const N = docs.length;
  const avg = docs.reduce((sum, d) => sum + d.length, 0) / Math.max(1, N);
  const df = new Map<string, number>();
  for (const doc of docs) for (const term of new Set(doc)) df.set(term, (df.get(term) ?? 0) + 1);
  return docs.map((doc) => {
    let score = 0;
    const tf = new Map<string, number>();
    for (const term of doc) tf.set(term, (tf.get(term) ?? 0) + 1);
    for (const term of query) {
      const f = tf.get(term);
      if (!f) continue;
      const n = df.get(term) ?? 0;
      const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5));
      score += idf * ((f * (k1 + 1)) / (f + k1 * (1 - b + b * (doc.length / Math.max(1, avg)))));
    }
    return score;
  });
}

function groundHolding(record: ProtestDecisionRecord, ground: Ground | undefined): DecisionGround | null {
  if (ground) return record.extracted.grounds.find((g) => g.ground === ground) ?? null;
  return record.extracted.grounds[0] ?? null;
}

/**
 * Hybrid retrieval: metadata filters, then BM25 over the holding-weighted
 * fields. Always returns the decision citation, link and the passage behind the
 * match.
 */
export function searchCorpus(query: string, filters: CorpusFilters, decisions: ProtestDecisionRecord[]): PrecedentHit[] {
  const limit = Math.max(1, Math.min(50, filters.limit ?? 10));
  const filtered = decisions.filter((d) => {
    if (filters.tribunal && d.tribunal !== filters.tribunal) return false;
    if (filters.agency && !d.agency.toLowerCase().includes(filters.agency.toLowerCase())) return false;
    if (filters.outcome && d.outcome !== filters.outcome) return false;
    if (filters.year && !d.decisionDate.startsWith(String(filters.year))) return false;
    if (filters.ground && !d.extracted.grounds.some((g) => g.ground === filters.ground)) return false;
    return true;
  });
  if (filtered.length === 0) return [];

  const queryTokens = tokenize(query);
  const docs = filtered.map((d) => {
    const groundText = groundHolding(d, filters.ground);
    const weighted = [
      groundText?.passage ?? "",
      groundText?.passage ?? "",
      d.extracted.grounds.map((g) => `${g.ground} ${g.holding} ${g.standard}`).join(" "),
      d.extracted.factors.join(" "),
      d.text.slice(0, 20_000),
    ];
    return tokenize(weighted.join(" "));
  });
  const scores = bm25(docs, queryTokens);

  const hits: PrecedentHit[] = [];
  filtered.forEach((record, i) => {
    const ground = groundHolding(record, filters.ground);
    const lexical = queryTokens.length === 0 ? 0 : scores[i] ?? 0;
    const metadataBonus = (filters.ground && ground?.ground === filters.ground ? 2 : 0) + (ground?.passage ? 0.5 : 0);
    hits.push({
      decisionId: record.id,
      citation: record.citation,
      url: record.url,
      tribunal: record.tribunal,
      decisionDate: record.decisionDate,
      agency: record.agency,
      outcome: record.outcome,
      ground: ground?.ground ?? null,
      holding: ground?.holding ?? "unknown",
      standard: ground?.standard ?? "unknown",
      passage: (ground?.passage ?? sentences(record.text)[0]?.text ?? "").slice(0, 600),
      score: Number((lexical + metadataBonus).toFixed(4)),
    });
  });
  return hits.sort((a, b) => b.score - a.score || b.decisionDate.localeCompare(a.decisionDate)).slice(0, limit);
}

/** Precedent for one ground, used by the twin and by debrief ground mapping. */
export function precedentsFor(ground: Ground, query: string, decisions: ProtestDecisionRecord[], limit = 3): PrecedentHit[] {
  const hits = searchCorpus(query, { ground, limit }, decisions);
  if (hits.length > 0) return hits;
  return searchCorpus(query, { limit }, decisions).slice(0, limit);
}

/** Aggregate what succeeds: sustained/denied counts per ground, with sample size. */
export function groundStatistics(decisions: ProtestDecisionRecord[]): { ground: Ground; sustained: number; denied: number; dismissed: number; sample: number }[] {
  return GROUNDS.map((ground) => {
    const rows = decisions.flatMap((d) => d.extracted.grounds.filter((g) => g.ground === ground));
    return {
      ground,
      sustained: rows.filter((r) => r.holding === "sustained").length,
      denied: rows.filter((r) => r.holding === "denied").length,
      dismissed: rows.filter((r) => r.holding === "dismissed").length,
      sample: rows.length,
    };
  }).filter((row) => row.sample > 0);
}

export const SOURCE_ALLOWLIST = ["gao.gov", "www.gao.gov", "uscfc.uscourts.gov", "www.uscfc.uscourts.gov"];

/**
 * Fetch a published decision from an official source. Only the two official
 * hosts are reachable through this path, over https, with the SSRF guard still
 * validating every hop. HTML is reduced to text; nothing is executed.
 */
export async function fetchDecisionText(url: string): Promise<string> {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:") throw new Error("Decisions are fetched over https only.");
  const host = parsed.hostname.toLowerCase();
  if (!SOURCE_ALLOWLIST.includes(host)) throw new Error(`Host ${host} is not an approved official source (${SOURCE_ALLOWLIST.join(", ")}).`);
  const { guardedFetch } = await import("@/lib/net-guard");
  const response = await guardedFetch(parsed.toString(), { headers: { accept: "text/html,text/plain" } });
  if (!response.ok) throw new Error(`Source returned HTTP ${response.status}.`);
  const raw = await response.text();
  if (raw.length > 4_000_000) throw new Error("Source document is too large to ingest.");
  const text = raw
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<\/(?:p|div|li|tr|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (text.length < 500) throw new Error("The fetched page is too short to be a decision; provide the text instead.");
  return text;
}
