// Evaluation Forensics API.
//
// One tenant-scoped surface for: the document vault (proposal, RFP, debrief),
// the protest corpus, the Evaluator Twin, Debrief Forensics, the protest clock,
// calibration and approval-gated exports. The guard authenticates and applies
// RBAC before any handler runs; every mutation is audited; every read is
// filtered by the caller's tenant inside the query.

import { z } from "zod";
import { guard, audit, auditStrict, isAdmin, capabilitySubject } from "@/lib/guard";
import { principalForSession } from "@/lib/rbac";
import { enforceRateLimit } from "@/lib/rate-limit";
import { planTransaction } from "@/lib/transaction";
import { computeProtestClock, clockSummary } from "@/lib/forensics/clock";
import {
  fetchDecisionText,
  groundStatistics,
  searchCorpus,
  SOURCE_ALLOWLIST,
} from "@/lib/forensics/corpus";
import { analyseDebrief } from "@/lib/forensics/debrief";
import { lintProposal } from "@/lib/forensics/legibility";
import { findOutcomePredictions } from "@/lib/forensics/legibility";
import { verifyQuote } from "@/lib/forensics/quote-check";
import { extractCriteria } from "@/lib/forensics/rfp";
import { registerForensicsActions } from "@/lib/forensics/actions";
import {
  acknowledgeClock,
  calibrationObservations,
  deleteDecision,
  deleteDocument,
  dispositionSummary,
  ForensicsError,
  getDebriefRun,
  getDocument,
  ingestDecision,
  listClocks,
  listDebriefRuns,
  listDecisions,
  listDocuments,
  listTwinRuns,
  saveCalibration,
  saveClock,
  saveDebriefRun,
  saveDocument,
  saveTwinRun,
  setFindingDisposition,
} from "@/lib/forensics/store";
import { calibrate, calibrationSummary, runTwin, schemeOf } from "@/lib/forensics/twin";
import { DISCLAIMER, GROUNDS, type Criterion } from "@/lib/forensics/types";

export const maxDuration = 60;

const ORIGINS = [
  "offeror",
  "offeror_counsel",
  "agency_debrief",
  "agency_notice",
  "public_decision",
  "awardee_at_debrief",
  "competitor_proposal",
  "source_selection_information",
] as const;

const attestationSchema = z.object({
  authorized: z.literal(true),
  origin: z.enum(ORIGINS),
  basis: z.string().trim().min(10).max(1000),
  attestedBy: z.string().trim().min(1).max(200),
  attestedAt: z.string().optional(),
  protectiveOrder: z.boolean().optional(),
  protectiveOrderAuthority: z.string().trim().max(300).optional(),
  authorizedUnderOrder: z.boolean().optional(),
});

const criterionSchema = z.object({
  id: z.string().min(1),
  factor: z.string().min(1),
  section: z.string(),
  text: z.string().min(1),
  kind: z.enum(["factor", "subfactor", "instruction", "shall"]),
});

const MAX_TEXT = 2_000_000;

const schema = z.discriminatedUnion("op", [
  z.object({
    op: z.literal("upload"),
    kind: z.enum(["proposal", "rfp", "debrief", "awardee_excerpt", "other"]),
    filename: z.string().trim().min(1).max(300),
    text: z.string().min(20).max(MAX_TEXT),
    pursuitId: z.string().trim().max(120).optional(),
    attestation: attestationSchema,
  }),
  z.object({ op: z.literal("delete-document"), id: z.string().min(1) }),
  z.object({ op: z.literal("criteria"), rfpDocumentId: z.string().min(1) }),
  z.object({ op: z.literal("lint"), documentId: z.string().min(1), rfpDocumentId: z.string().optional() }),
  z.object({
    op: z.literal("clock"),
    noticeDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    basisKnownDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    debriefDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    proposalsDueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    pursuitId: z.string().min(1).max(120),
    save: z.boolean().optional(),
  }),
  z.object({ op: z.literal("clock-ack"), id: z.string().min(1) }),
  z.object({
    op: z.literal("twin"),
    proposalDocumentId: z.string().min(1),
    rfpDocumentId: z.string().optional(),
    criteria: z.array(criterionSchema).max(120).optional(),
    pursuitId: z.string().max(120).optional(),
    proposalVersion: z.string().max(120).optional(),
    modelId: z.string().max(200).optional(),
  }),
  z.object({
    op: z.literal("debrief"),
    proposalDocumentId: z.string().min(1),
    debriefDocumentId: z.string().min(1),
    rfpDocumentId: z.string().optional(),
    awardeeExcerptDocumentId: z.string().optional(),
    criteria: z.array(criterionSchema).max(120).optional(),
    pursuitId: z.string().max(120).optional(),
  }),
  z.object({
    op: z.literal("precedent"),
    query: z.string().trim().min(3).max(2000),
    ground: z.enum(GROUNDS).optional(),
    agency: z.string().max(200).optional(),
    outcome: z.enum(["sustained", "denied", "dismissed", "unknown"]).optional(),
    year: z.number().int().min(1990).max(2100).optional(),
    limit: z.number().int().min(1).max(20).optional(),
  }),
  z.object({
    op: z.literal("ingest-decision"),
    text: z.string().max(4_000_000).optional(),
    url: z.string().url().optional(),
    citation: z.string().max(300).optional(),
    tribunal: z.enum(["GAO", "COFC"]).optional(),
    agency: z.string().max(200).optional(),
    decisionDate: z.string().optional(),
  }),
  z.object({ op: z.literal("delete-decision"), id: z.string().min(1) }),
  z.object({ op: z.literal("export-counsel"), debriefRunId: z.string().min(1) }),
  z.object({
    op: z.literal("draft-debrief-request"),
    pursuitId: z.string().min(1).max(120),
    solicitation: z.string().min(1).max(200),
    noticeDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    offerorName: z.string().min(1).max(200),
    recipient: z.string().max(200).optional(),
  }),
  z.object({
    op: z.literal("disposition"),
    findingId: z.string().min(1),
    runId: z.string().optional(),
    disposition: z.enum(["helpful", "wrong", "missed"]).nullable(),
  }),
  z.object({
    op: z.literal("calibrate"),
    runId: z.string().optional(),
    observations: z
      .array(
        z.object({
          factor: z.string().min(1),
          predicted: z.enum(["strength", "weakness", "significant weakness", "deficiency"]),
          actual: z.enum(["strength", "weakness", "significant weakness", "deficiency"]),
        }),
      )
      .min(1)
      .max(500),
  }),
]);

function bad(message: string, issues?: unknown) {
  return Response.json({ error: { message, ...(issues ? { issues } : {}) } }, { status: 400 });
}

export async function GET(req: Request) {
  const gate = await guard(req, { role: "viewer" });
  if (gate instanceof Response) return gate;
  const { tenant } = principalForSession(gate);
  const admin = isAdmin(gate);
  const decisions = listDecisions(2000);
  return Response.json({
    documents: listDocuments(tenant).map((doc) => ({
      id: doc.id,
      kind: doc.kind,
      filename: doc.filename,
      origin: doc.origin,
      pursuitId: doc.pursuit_id,
      protectiveOrder: doc.protective_order,
      contentHash: doc.content_hash,
      createdAt: doc.created_at,
    })),
    twinRuns: listTwinRuns(tenant),
    debriefRuns: listDebriefRuns(tenant),
    clocks: listClocks(tenant).map((row) => ({ id: row.id, pursuitId: row.pursuit_id, acknowledged: row.acknowledged, clock: row.clock, summary: clockSummary(row.clock) })),
    corpus: { size: decisions.length, statistics: groundStatistics(decisions), sources: SOURCE_ALLOWLIST },
    calibration: { results: calibrate(calibrationObservations(tenant)), summary: calibrationSummary(calibrate(calibrationObservations(tenant))), dispositions: dispositionSummary(tenant) },
    disclaimer: DISCLAIMER,
    admin,
  });
}

export async function POST(req: Request) {
  const gate = await guard(req, { role: "member" });
  if (gate instanceof Response) return gate;
  const limited = enforceRateLimit(capabilitySubject(gate), "forensics", 30, 60_000);
  if (limited) return limited;

  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return bad("Invalid forensics operation.", parsed.error.issues);
  const body = parsed.data;
  const principal = principalForSession(gate);
  const { tenant, owner } = principal;

  try {
    switch (body.op) {
      case "upload": {
        const saved = saveDocument({
          tenant,
          actor: owner,
          pursuitId: body.pursuitId,
          submission: {
            kind: body.kind,
            filename: body.filename,
            text: body.text,
            attestation: { ...body.attestation, attestedAt: body.attestation.attestedAt ?? new Date().toISOString() },
          },
        });
        audit(req, gate, "forensics.document.upload", saved.document.id, {
          kind: body.kind,
          origin: body.attestation.origin,
          protectiveOrder: saved.document.protective_order,
          hash: saved.document.content_hash,
        });
        return Response.json({ document: saved.document, sharesIntoCorpus: saved.sharesIntoCorpus });
      }
      case "delete-document": {
        deleteDocument(tenant, body.id);
        auditStrict(req, gate, "forensics.document.delete", body.id, {});
        return Response.json({ ok: true });
      }
      case "criteria": {
        const { text } = getDocument(tenant, body.rfpDocumentId);
        const criteria = extractCriteria(text);
        return Response.json({ criteria, count: criteria.length });
      }
      case "lint": {
        const { text } = getDocument(tenant, body.documentId);
        const criteria = body.rfpDocumentId ? extractCriteria(getDocument(tenant, body.rfpDocumentId).text) : [];
        const report = lintProposal({ text, criteria });
        audit(req, gate, "forensics.lint", body.documentId, { verdict: report.verdict, concealed: report.concealed.length });
        return Response.json({ report });
      }
      case "clock": {
        const clock = computeProtestClock({
          noticeDate: body.noticeDate,
          basisKnownDate: body.basisKnownDate,
          debriefDate: body.debriefDate,
          proposalsDueDate: body.proposalsDueDate,
        });
        const saved = body.save ? saveClock({ tenant, actor: owner, pursuitId: body.pursuitId, clock }) : null;
        if (saved) audit(req, gate, "forensics.clock.save", saved.id, { pursuitId: body.pursuitId, controlling: clock.controllingFilingDeadline });
        return Response.json({ clock, summary: clockSummary(clock), savedId: saved?.id ?? null });
      }
      case "clock-ack": {
        acknowledgeClock(tenant, body.id, owner);
        auditStrict(req, gate, "forensics.clock.acknowledge", body.id, {});
        return Response.json({ ok: true });
      }
      case "twin": {
        const proposal = getDocument(tenant, body.proposalDocumentId).text;
        const rfp = body.rfpDocumentId ? getDocument(tenant, body.rfpDocumentId).text : "";
        const criteria = (body.criteria as Criterion[] | undefined) ?? (rfp ? extractCriteria(rfp) : []);
        if (criteria.length === 0) return bad("Supply Section M criteria or an RFP document.");
        const report = await runTwin({ proposal, criteria, rfp, decisions: listDecisions(500), scheme: schemeOf(rfp), modelId: body.modelId });
        const predictions = findOutcomePredictions(JSON.stringify(report));
        if (predictions.length > 0) return bad("A report may not contain outcome predictions.", predictions);
        const run = saveTwinRun({ tenant, actor: owner, pursuitId: body.pursuitId, proposalVersion: body.proposalVersion, report });
        audit(req, gate, "forensics.twin.run", run.id, {
          mode: report.mode,
          findings: report.findings.length,
          discarded: report.discarded.length,
          proposal: body.proposalDocumentId,
        });
        return Response.json({ runId: run.id, report });
      }
      case "debrief": {
        const proposal = getDocument(tenant, body.proposalDocumentId).text;
        const debrief = getDocument(tenant, body.debriefDocumentId).text;
        const rfp = body.rfpDocumentId ? getDocument(tenant, body.rfpDocumentId).text : "";
        const criteria = (body.criteria as Criterion[] | undefined) ?? (rfp ? extractCriteria(rfp) : []);
        if (criteria.length === 0) return bad("Supply Section M criteria or an RFP document.");
        const awardeeExcerpts = body.awardeeExcerptDocumentId ? getDocument(tenant, body.awardeeExcerptDocumentId).text : undefined;
        const report = analyseDebrief({ proposal, debrief, criteria, awardeeExcerpts, decisions: listDecisions(500) });
        const predictions = findOutcomePredictions(JSON.stringify(report));
        if (predictions.length > 0) return bad("A report may not contain outcome predictions.", predictions);
        const run = saveDebriefRun({ tenant, actor: owner, pursuitId: body.pursuitId, documentId: body.debriefDocumentId, report });
        audit(req, gate, "forensics.debrief.run", run.id, {
          findings: report.findings.length,
          contradicted: report.findings.filter((f) => f.verification === "contradicted").length,
          discardedQuotes: report.discardedQuotes.length,
        });
        return Response.json({ runId: run.id, report });
      }
      case "precedent": {
        const decisions = listDecisions(2000);
        const hits = searchCorpus(body.query, { ground: body.ground, agency: body.agency, outcome: body.outcome, year: body.year, limit: body.limit }, decisions);
        return Response.json({ hits, corpusSize: decisions.length, disclaimer: DISCLAIMER });
      }
      case "ingest-decision": {
        if (!isAdmin(gate)) return Response.json({ error: { message: "Only an admin may ingest corpus decisions." } }, { status: 403 });
        const text = body.text ?? (body.url ? await fetchDecisionText(body.url) : "");
        if (!text) return bad("Provide decision text or an official URL.");
        const record = ingestDecision({ text, meta: { citation: body.citation, tribunal: body.tribunal, agency: body.agency, decisionDate: body.decisionDate, url: body.url }, actor: owner });
        auditStrict(req, gate, "forensics.corpus.ingest", record.id, { docket: record.docket, grounds: record.extracted.grounds.length, version: record.extractionVersion });
        return Response.json({ decision: record });
      }
      case "delete-decision": {
        if (!isAdmin(gate)) return Response.json({ error: { message: "Only an admin may delete corpus decisions." } }, { status: 403 });
        deleteDecision(body.id);
        auditStrict(req, gate, "forensics.corpus.delete", body.id, {});
        return Response.json({ ok: true });
      }
      case "export-counsel": {
        registerForensicsActions();
        const report = getDebriefRun(tenant, body.debriefRunId);
        const tx = planTransaction(
          { tenant, actor: owner, roles: gate.roles ?? [] },
          "Export forensics counsel package",
          "Write the verification table, issue list and precedent links to the local exports folder for counsel review. No agency contact and no filing.",
          [
            {
              kind: "forensics.counsel_export",
              target: body.debriefRunId,
              payload: { tenant, runId: body.debriefRunId },
              expected: `A JSON package with ${report.findings.length} findings, removable by undo.`,
            },
          ],
        );
        audit(req, gate, "forensics.export.plan", tx.id, { debriefRunId: body.debriefRunId });
        return Response.json({ transactionId: tx.id, status: tx.status });
      }
      case "draft-debrief-request": {
        registerForensicsActions();
        const draftText = [
          `Subject: Request for debriefing — ${body.solicitation}`,
          "",
          `${body.recipient ?? "Contracting Officer"},`,
          "",
          `${body.offerorName} requests a debriefing under FAR 15.505 following the notice dated ${body.noticeDate}. Please confirm the date, time and format, and provide the evaluation findings, the basis for the rating on each factor, and the overall best-value rationale.`,
          "",
          "We are not requesting source selection information that may not be released. Please identify any material that requires a protective order.",
          "",
          `${body.offerorName}`,
        ].join("\n");
        const tx = planTransaction(
          { tenant, actor: owner, roles: gate.roles ?? [] },
          `Draft debrief request for ${body.solicitation}`,
          "Write a debrief-request draft to the local exports folder. The user reviews and sends it; Quillon never contacts an agency.",
          [
            {
              kind: "forensics.debrief_request_draft",
              target: body.pursuitId,
              payload: { tenant, pursuitId: body.pursuitId, draftText, noticeDate: body.noticeDate },
              expected: "A markdown draft in .data/forensics-exports, removable by undo.",
            },
          ],
        );
        return Response.json({ transactionId: tx.id, status: tx.status, draftPreview: draftText });
      }
      case "disposition": {
        setFindingDisposition(tenant, body.findingId, body.disposition, body.runId);
        audit(req, gate, "forensics.finding.disposition", body.findingId, { disposition: body.disposition });
        return Response.json({ ok: true });
      }
      case "calibrate": {
        const written = saveCalibration(tenant, owner, body.runId ?? null, body.observations);
        audit(req, gate, "forensics.calibration.record", body.runId ?? "manual", { observations: written });
        const results = calibrate(calibrationObservations(tenant));
        return Response.json({ written, results, summary: calibrationSummary(results) });
      }
    }
  } catch (err) {
    if (err instanceof ForensicsError) {
      const status = err.code === "denied" ? 403 : err.code === "not_found" ? 404 : err.code === "conflict" ? 409 : 400;
      return Response.json({ error: { message: err.message, code: err.code } }, { status });
    }
    const message = err instanceof Error ? err.message : "Forensics operation failed.";
    return Response.json({ error: { message } }, { status: 500 });
  }
}
