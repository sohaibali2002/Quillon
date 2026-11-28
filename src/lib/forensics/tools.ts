// Forensics tools exposed to chat and agents.
//
// Each tool closes over the caller's tenant and actor, so a model cannot widen
// its own scope: document reads go through getDocument(tenant, id), runs are
// stamped with the tenant, and the two outbound actions only ever plan a
// transaction for a human to approve. Everything returned here is record-based
// analysis, with the not-legal-advice line attached.

import { tool } from "ai";
import { z } from "zod";
import { planTransaction } from "@/lib/transaction";
import { registerForensicsActions } from "./actions";
import { FW_TOOL_CLASSES } from "./classes";
import { computeProtestClock, clockSummary } from "./clock";
import { fetchDecisionText, groundStatistics, precedentsFor, searchCorpus, SOURCE_ALLOWLIST } from "./corpus";
import { analyseDebrief } from "./debrief";
import { lintProposal } from "./legibility";
import { verifyQuote } from "./quote-check";
import { extractCriteria } from "./rfp";
import {
  getDocument,
  ingestDecision,
  listClocks,
  listDebriefRuns,
  listDecisions,
  listDocuments,
  listTwinRuns,
  saveClock,
  saveDebriefRun,
  saveTwinRun,
  calibrationObservations,
  dispositionSummary,
} from "./store";
import { calibrate, calibrationSummary, runTwin, schemeOf } from "./twin";
import { DISCLAIMER, GROUNDS, type Criterion } from "./types";

const groundEnum = z.enum(GROUNDS);

const criterionSchema = z.object({
  id: z.string(),
  factor: z.string(),
  section: z.string(),
  text: z.string(),
  kind: z.enum(["factor", "subfactor", "instruction", "shall"]),
});

function criteriaFrom(tenant: string, ids: { rfpDocumentId?: string }, explicit?: Criterion[]): Criterion[] {
  if (explicit && explicit.length > 0) return explicit;
  if (ids.rfpDocumentId) {
    const { text } = getDocument(tenant, ids.rfpDocumentId);
    return extractCriteria(text);
  }
  return [];
}

export function buildForensicsTools(tenant: string, actor: string, roles: string[] = ["member"]) {
  registerForensicsActions();

  return {
    fw_search_precedent: tool({
      description:
        "Search the public protest-decision corpus (GAO, Court of Federal Claims). Hybrid: metadata filters plus relevance over holdings. Every hit carries its citation and link, and the passage behind the match. Use for what grounds succeed and how tribunals treated similar evaluation conduct.",
      inputSchema: z.object({
        query: z.string().min(3).describe("Fact pattern, for example 'weakness for content the RFP did not require'"),
        ground: groundEnum.optional(),
        agency: z.string().optional(),
        outcome: z.enum(["sustained", "denied", "dismissed", "unknown"]).optional(),
        year: z.number().int().min(1990).max(2100).optional(),
        limit: z.number().int().min(1).max(20).optional(),
      }),
      execute: async ({ query, ground, agency, outcome, year, limit }) => {
        const decisions = listDecisions(1000);
        const hits = searchCorpus(query, { ground, agency, outcome, year, limit: limit ?? 8 }, decisions);
        return { disclaimer: DISCLAIMER, corpusSize: decisions.length, hits };
      },
    }),

    fw_ground_statistics: tool({
      description: "Counts of sustained, denied and dismissed holdings per protest ground in the local corpus, with sample sizes. Counts, never probabilities.",
      inputSchema: z.object({}),
      execute: async () => {
        const decisions = listDecisions(2000);
        return { corpusSize: decisions.length, statistics: groundStatistics(decisions), disclaimer: "Counts from the ingested corpus only; a sample of decisions is not a base rate." };
      },
    }),

    fw_verify_quote: tool({
      description:
        "Check whether a quote exists verbatim in a stored document. Deterministic string match after Unicode and whitespace normalisation; returns the page and line. Use before repeating any quoted proposal content.",
      inputSchema: z.object({ documentId: z.string(), quote: z.string().min(8) }),
      execute: async ({ documentId, quote }) => {
        const { text } = getDocument(tenant, documentId);
        return verifyQuote(quote, text);
      },
    }),

    fw_lint_proposal: tool({
      description:
        "AI-legibility lint for a stored proposal: Section M headings mirrored, discriminators measurable, acronyms defined, cross-references resolving, tables machine-readable, and detection of concealed or evaluator-addressed content (which fails the draft).",
      inputSchema: z.object({ documentId: z.string(), rfpDocumentId: z.string().optional() }),
      execute: async ({ documentId, rfpDocumentId }) => {
        const { text } = getDocument(tenant, documentId);
        const criteria = criteriaFrom(tenant, { rfpDocumentId });
        return lintProposal({ text, criteria });
      },
    }),

    fw_compute_clock: tool({
      description:
        "Compute GAO protest windows from the award or exclusion notice date: debrief request, filing after debrief or from the basis being known, automatic stay triggers, and solicitation-term challenges. Every date carries its rule text and source and is marked verify-with-counsel.",
      inputSchema: z.object({
        noticeDate: z.string().describe("YYYY-MM-DD"),
        basisKnownDate: z.string().optional(),
        debriefDate: z.string().optional(),
        proposalsDueDate: z.string().optional(),
        pursuitId: z.string().optional(),
        save: z.boolean().optional().describe("Persist the clock for alerts"),
      }),
      execute: async ({ noticeDate, basisKnownDate, debriefDate, proposalsDueDate, pursuitId, save }) => {
        const clock = computeProtestClock({ noticeDate, basisKnownDate, debriefDate, proposalsDueDate });
        const saved = save && pursuitId ? saveClock({ tenant, actor, pursuitId, clock }) : null;
        return { clock, summary: clockSummary(clock), savedId: saved?.id ?? null };
      },
    }),

    fw_list_clocks: tool({
      description: "List saved protest clocks for this tenant with their controlling filing deadline and whether a human acknowledged them.",
      inputSchema: z.object({ pursuitId: z.string().optional() }),
      execute: async ({ pursuitId }) => {
        const clocks = listClocks(tenant, pursuitId);
        return clocks.map((row) => ({ id: row.id, pursuitId: row.pursuit_id, acknowledged: row.acknowledged, summary: clockSummary(row.clock), controlling: row.clock.controllingFilingDeadline }));
      },
    }),

    fw_run_twin: tool({
      description:
        "Run the Evaluator Twin: an independent simulated source selection panel over a stored draft proposal against the RFP's Section M criteria. FAR 15.001 vocabulary, verbatim quotes only (unverifiable findings are discarded and listed), ratings only from the RFP's own scheme, precedents from the corpus.",
      inputSchema: z.object({
        proposalDocumentId: z.string(),
        rfpDocumentId: z.string().optional(),
        criteria: z.array(criterionSchema).optional(),
        pursuitId: z.string().optional(),
        proposalVersion: z.string().optional(),
        modelId: z.string().optional(),
      }),
      execute: async ({ proposalDocumentId, rfpDocumentId, criteria, pursuitId, proposalVersion, modelId }) => {
        const proposal = getDocument(tenant, proposalDocumentId).text;
        const rfp = rfpDocumentId ? getDocument(tenant, rfpDocumentId).text : "";
        const resolved = criteriaFrom(tenant, { rfpDocumentId }, criteria as Criterion[] | undefined);
        if (resolved.length === 0) throw new Error("Supply Section M criteria or an RFP document.");
        const report = await runTwin({ proposal, criteria: resolved, rfp, decisions: listDecisions(500), scheme: schemeOf(rfp), modelId });
        const run = saveTwinRun({ tenant, actor, pursuitId, proposalVersion, report });
        return {
          runId: run.id,
          mode: report.mode,
          findings: report.findings.length,
          discarded: report.discarded.length,
          ratings: report.ratings,
          topFindings: report.findings.slice(0, 10),
          disclaimer: report.disclaimer,
        };
      },
    }),

    fw_verify_debrief: tool({
      description:
        "Debrief Forensics: atomize a stored debrief into findings, trace each to a stated criterion, verify each claim against the stored proposal (supported, contradicted, absent, ambiguous) with side-by-side quotes, run consistency and process-integrity checks, map grounds and precedent, and rank issues by materiality. Not legal advice.",
      inputSchema: z.object({
        proposalDocumentId: z.string(),
        debriefDocumentId: z.string(),
        rfpDocumentId: z.string().optional(),
        awardeeExcerptDocumentId: z.string().optional(),
        criteria: z.array(criterionSchema).optional(),
        pursuitId: z.string().optional(),
      }),
      execute: async ({ proposalDocumentId, debriefDocumentId, rfpDocumentId, awardeeExcerptDocumentId, criteria, pursuitId }) => {
        const proposal = getDocument(tenant, proposalDocumentId).text;
        const debrief = getDocument(tenant, debriefDocumentId).text;
        const rfp = rfpDocumentId ? getDocument(tenant, rfpDocumentId).text : "";
        const resolved = criteriaFrom(tenant, { rfpDocumentId }, criteria as Criterion[] | undefined);
        if (resolved.length === 0) throw new Error("Supply Section M criteria or an RFP document.");
        const awardeeExcerpts = awardeeExcerptDocumentId ? getDocument(tenant, awardeeExcerptDocumentId).text : undefined;
        const report = analyseDebrief({ proposal, debrief, criteria: resolved, awardeeExcerpts, decisions: listDecisions(500) });
        const run = saveDebriefRun({ tenant, actor, pursuitId, documentId: debriefDocumentId, report });
        return {
          runId: run.id,
          summary: report.summary,
          counts: {
            findings: report.findings.length,
            contradicted: report.findings.filter((f) => f.verification === "contradicted").length,
            highMateriality: report.issues.filter((i) => i.materiality === "high").length,
          },
          issues: report.issues.slice(0, 15),
          findings: report.findings.slice(0, 25),
          disparateTreatment: report.disparateTreatment,
          discardedQuotes: report.discardedQuotes,
          disclaimer: report.disclaimer,
          standardOfReview: report.standardOfReview,
        };
      },
    }),

    fw_list_documents: tool({
      description: "List stored forensics documents for this tenant (proposal, RFP, debrief, awardee excerpts) with origin, attestation and whether a protective order applies.",
      inputSchema: z.object({ pursuitId: z.string().optional() }),
      execute: async ({ pursuitId }) =>
        listDocuments(tenant, pursuitId).map((doc) => ({
          id: doc.id,
          kind: doc.kind,
          filename: doc.filename,
          origin: doc.origin,
          protectiveOrder: doc.protective_order,
          createdAt: doc.created_at,
        })),
    }),

    fw_list_runs: tool({
      description: "List recent Evaluator Twin and Debrief Forensics runs for this tenant, with calibration sample counts.",
      inputSchema: z.object({}),
      execute: async () => {
        const observations = calibrationObservations(tenant);
        return {
          twinRuns: listTwinRuns(tenant),
          debriefRuns: listDebriefRuns(tenant),
          calibration: calibrationSummary(calibrate(observations)),
          dispositions: dispositionSummary(tenant),
        };
      },
    }),

    fw_export_counsel_package: tool({
      description:
        "Plan an approval-gated export of a debrief run as a counsel package (issue list, citations, quotes, precedent links). Creates a transaction; nothing is written until a human approves it.",
      inputSchema: z.object({ debriefRunId: z.string(), title: z.string().optional() }),
      execute: async ({ debriefRunId, title }) => {
        const tx = planTransaction(
          { tenant, actor, roles },
          title ?? "Export forensics counsel package",
          "Write the debrief verification table, issue list and precedent links to the local exports folder for counsel review. No agency contact, no filing.",
          [
            {
              kind: "forensics.counsel_export",
              target: debriefRunId,
              payload: { tenant, runId: debriefRunId },
              expected: "A JSON counsel package in .data/forensics-exports, removable by undo.",
            },
          ],
        );
        return { transactionId: tx.id, status: tx.status, requiresApproval: true, disclaimer: DISCLAIMER };
      },
    }),

    fw_draft_debrief_request: tool({
      description:
        "Plan an approval-gated draft of a debriefing request for the contracting officer, written to a local file for the user to review and send themselves. Nothing is sent.",
      inputSchema: z.object({
        pursuitId: z.string(),
        solicitation: z.string(),
        noticeDate: z.string(),
        offerorName: z.string(),
        recipient: z.string().optional(),
      }),
      execute: async ({ pursuitId, solicitation, noticeDate, offerorName, recipient }) => {
        const draftText = [
          `Subject: Request for debriefing — ${solicitation}`,
          "",
          `${recipient ?? "Contracting Officer"},`,
          "",
          `${offerorName} requests a debriefing under FAR 15.505 following the notice dated ${noticeDate}. Please confirm the date, time and format, and provide the evaluation findings, the basis for the rating on each factor, and the overall best-value rationale.`,
          "",
          "We are not requesting source selection information that may not be released. Please identify any material that requires a protective order.",
          "",
          `${offerorName}`,
        ].join("\n");
        const tx = planTransaction(
          { tenant, actor, roles },
          `Draft debrief request for ${solicitation}`,
          "Write a debrief-request draft to the local exports folder. The user reviews and sends it; Quillon never contacts an agency.",
          [
            {
              kind: "forensics.debrief_request_draft",
              target: `${pursuitId}`,
              payload: { tenant, pursuitId, draftText, noticeDate },
              expected: "A markdown draft in .data/forensics-exports, removable by undo.",
            },
          ],
        );
        return { transactionId: tx.id, status: tx.status, draftPreview: draftText, requiresApproval: true };
      },
    }),

    fw_ingest_decision: tool({
      description:
        "Ingest one published protest decision into the corpus (admin). Supply either the decision text or an official URL (gao.gov or uscfc.uscourts.gov). Extraction is versioned and every extracted field keeps its source passage.",
      inputSchema: z.object({
        text: z.string().optional(),
        url: z.string().url().optional(),
        citation: z.string().optional(),
        tribunal: z.enum(["GAO", "COFC"]).optional(),
        agency: z.string().optional(),
        decisionDate: z.string().optional(),
      }),
      execute: async ({ text, url, citation, tribunal, agency, decisionDate }) => {
        const body = text ?? (url ? await fetchDecisionText(url) : "");
        if (!body) throw new Error("Provide decision text or an official URL.");
        const record = ingestDecision({ text: body, meta: { citation, tribunal, agency, decisionDate, url }, actor });
        return { id: record.id, citation: record.citation, tribunal: record.tribunal, docket: record.docket, grounds: record.extracted.grounds.map((g) => ({ ground: g.ground, holding: g.holding })), extractionVersion: record.extractionVersion, sources: SOURCE_ALLOWLIST };
      },
    }),

    fw_precedent_for_ground: tool({
      description: "Precedent for one protest ground, with the tribunal's holding and the passage. Use to ground a suspected issue before recommending it to counsel.",
      inputSchema: z.object({ ground: groundEnum, query: z.string().min(3), limit: z.number().int().min(1).max(10).optional() }),
      execute: async ({ ground, query, limit }) => ({ ground, hits: precedentsFor(ground, query, listDecisions(1000), limit ?? 3) }),
    }),
  };
}

export { FW_TOOL_CLASSES } from "./classes";
