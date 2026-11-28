// Persistence for Evaluation Forensics.
//
// Every tenant-scoped read takes the caller's tenant and filters on it; a row
// that belongs to another tenant is indistinguishable from a missing row
// (FORBIDDEN rather than NOT FOUND would confirm it exists). The protest corpus
// is different by design: it holds published decisions only, never a customer's
// proposal, debrief or protective-order material.

import { randomUUID } from "node:crypto";
import { getDb } from "@/lib/db";
import { reviewSubmission, contentHash, type Attestation, type DocumentKind, type DocumentOrigin, type DocumentSubmission } from "./attestation";
import { EXTRACTION_VERSION, parseDecision, type DecisionMeta, type ProtestDecisionRecord } from "./corpus";
import { GROUND_KEYWORDS, type DebriefFindingRecord, type ForensicsReport, type TwinReport } from "./types";
import type { ProtestClock } from "./clock";
import type { CalibrationObservation } from "./twin";

export type ForensicsErrorCode = "denied" | "not_found" | "invalid" | "conflict";

export class ForensicsError extends Error {
  code: ForensicsErrorCode;
  constructor(code: ForensicsErrorCode, message: string) {
    super(message);
    this.name = "ForensicsError";
    this.code = code;
  }
}

export interface StoredDocument {
  id: string;
  tenant_id: string;
  pursuit_id: string | null;
  kind: DocumentKind;
  filename: string;
  content_hash: string;
  origin: DocumentOrigin;
  attestation: Attestation;
  protective_order: boolean;
  created_by: string;
  created_at: string;
}

function parseJson<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

export function saveDocument(input: {
  tenant: string;
  actor: string;
  pursuitId?: string;
  submission: DocumentSubmission;
}): { document: StoredDocument; sharesIntoCorpus: boolean } {
  const verdict = reviewSubmission(input.submission);
  if (!verdict.allowed) throw new ForensicsError("denied", verdict.reason);
  const attestation = input.submission.attestation;
  const id = randomUUID();
  const row: StoredDocument = {
    id,
    tenant_id: input.tenant,
    pursuit_id: input.pursuitId ?? null,
    kind: input.submission.kind,
    filename: input.submission.filename,
    content_hash: verdict.contentHash,
    origin: attestation.origin,
    attestation,
    protective_order: attestation.protectiveOrder === true,
    created_by: input.actor,
    created_at: new Date().toISOString(),
  };
  getDb()
    .prepare(
      `INSERT INTO forensics_documents
       (id, tenant_id, pursuit_id, kind, filename, content_hash, origin, attestation_json, protective_order, text, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      row.id,
      row.tenant_id,
      row.pursuit_id,
      row.kind,
      row.filename,
      row.content_hash,
      row.origin,
      JSON.stringify(attestation),
      row.protective_order ? 1 : 0,
      input.submission.text,
      row.created_by,
      row.created_at,
    );
  return { document: row, sharesIntoCorpus: verdict.sharesIntoCorpus };
}

export function listDocuments(tenant: string, pursuitId?: string): StoredDocument[] {
  const db = getDb();
  const rows = pursuitId
    ? (db.prepare("SELECT * FROM forensics_documents WHERE tenant_id = ? AND pursuit_id = ? ORDER BY created_at DESC").all(tenant, pursuitId) as Record<string, unknown>[])
    : (db.prepare("SELECT * FROM forensics_documents WHERE tenant_id = ? ORDER BY created_at DESC").all(tenant) as Record<string, unknown>[]);
  return rows.map(toDocument);
}

function toDocument(row: Record<string, unknown>): StoredDocument {
  return {
    id: String(row.id),
    tenant_id: String(row.tenant_id),
    pursuit_id: row.pursuit_id ? String(row.pursuit_id) : null,
    kind: String(row.kind) as DocumentKind,
    filename: String(row.filename),
    content_hash: String(row.content_hash),
    origin: String(row.origin) as DocumentOrigin,
    attestation: parseJson<Attestation>(String(row.attestation_json ?? ""), {
      authorized: false,
      origin: "other" as DocumentOrigin,
      basis: "",
      attestedBy: "",
      attestedAt: "",
    }),
    protective_order: Number(row.protective_order) === 1,
    created_by: String(row.created_by),
    created_at: String(row.created_at),
  };
}

export function getDocument(tenant: string, id: string): { document: StoredDocument; text: string } {
  const row = getDb()
    .prepare("SELECT * FROM forensics_documents WHERE id = ? AND tenant_id = ?")
    .get(id, tenant) as Record<string, unknown> | undefined;
  if (!row) throw new ForensicsError("not_found", "Document not found.");
  return { document: toDocument(row), text: String(row.text) };
}

export function deleteDocument(tenant: string, id: string): void {
  const result = getDb().prepare("DELETE FROM forensics_documents WHERE id = ? AND tenant_id = ?").run(id, tenant);
  if (Number(result.changes) === 0) throw new ForensicsError("not_found", "Document not found.");
}

// ---------------------------------------------------------------- corpus

export function ingestDecision(input: { text: string; meta: DecisionMeta; actor: string }): ProtestDecisionRecord {
  const record = parseDecision(randomUUID(), input.text, input.meta, GROUND_KEYWORDS);
  if (!record.docket && !input.meta.citation) throw new ForensicsError("invalid", "A decision needs a docket number or a citation.");
  if (record.tribunal === "unknown") throw new ForensicsError("invalid", "The tribunal could not be identified; label it GAO or COFC before ingesting.");
  if (record.text.trim().length < 200) throw new ForensicsError("invalid", "The decision text is too short to extract.");

  const db = getDb();
  const existing = record.docket
    ? (db.prepare("SELECT id, extraction_version FROM protest_decisions WHERE tribunal = ? AND docket = ?").get(record.tribunal, record.docket) as { id: string; extraction_version: string } | undefined)
    : undefined;
  const id = existing?.id ?? record.id;
  const finalRecord: ProtestDecisionRecord = { ...record, id };

  db.prepare(
    `INSERT INTO protest_decisions (id, tribunal, docket, decision_date, agency, citation, url, outcome, text, extracted_json, extraction_version, content_hash)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       decision_date = excluded.decision_date, agency = excluded.agency, citation = excluded.citation,
       url = excluded.url, outcome = excluded.outcome, text = excluded.text,
       extracted_json = excluded.extracted_json, extraction_version = excluded.extraction_version,
       content_hash = excluded.content_hash`,
  ).run(
    finalRecord.id,
    finalRecord.tribunal,
    finalRecord.docket,
    finalRecord.decisionDate,
    finalRecord.agency,
    finalRecord.citation,
    finalRecord.url,
    finalRecord.outcome,
    finalRecord.text,
    JSON.stringify(finalRecord.extracted),
    EXTRACTION_VERSION,
    contentHash(finalRecord.text),
  );

  db.prepare("DELETE FROM decision_grounds WHERE decision_id = ?").run(finalRecord.id);
  const insertGround = db.prepare("INSERT OR REPLACE INTO decision_grounds (decision_id, ground, holding, standard, passage) VALUES (?, ?, ?, ?, ?)");
  for (const ground of finalRecord.extracted.grounds) {
    insertGround.run(finalRecord.id, ground.ground, ground.holding, ground.standard, ground.passage);
  }
  return finalRecord;
}

export function listDecisions(limit = 500): ProtestDecisionRecord[] {
  const rows = getDb().prepare("SELECT * FROM protest_decisions ORDER BY decision_date DESC LIMIT ?").all(Math.min(2000, Math.max(1, limit))) as Record<string, unknown>[];
  return rows.map((row) => ({
    id: String(row.id),
    tribunal: String(row.tribunal) as ProtestDecisionRecord["tribunal"],
    docket: String(row.docket),
    decisionDate: String(row.decision_date),
    agency: String(row.agency),
    citation: String(row.citation),
    url: String(row.url),
    outcome: String(row.outcome) as ProtestDecisionRecord["outcome"],
    text: String(row.text),
    extracted: parseJson<ProtestDecisionRecord["extracted"]>(String(row.extracted_json ?? ""), {
      tribunal: "unknown",
      docket: "",
      decisionDate: "",
      agency: "unknown",
      solicitationType: "unknown",
      scheme: "unknown",
      outcome: "unknown",
      factors: [],
      grounds: [],
      remedy: "",
      passages: [],
    }),
    extractionVersion: String(row.extraction_version),
  }));
}

export function deleteDecision(decisionId: string): void {
  const result = getDb().prepare("DELETE FROM protest_decisions WHERE id = ?").run(decisionId);
  getDb().prepare("DELETE FROM decision_grounds WHERE decision_id = ?").run(decisionId);
  if (Number(result.changes) === 0) throw new ForensicsError("not_found", "Decision not found.");
}

// ---------------------------------------------------------------- runs

export interface StoredRun {
  id: string;
  tenant_id: string;
  pursuit_id: string | null;
  created_by: string;
  created_at: string;
}

export function saveTwinRun(input: { tenant: string; actor: string; pursuitId?: string; proposalVersion?: string; report: TwinReport }): StoredRun {
  const db = getDb();
  const id = randomUUID();
  const created_at = new Date().toISOString();
  db.exec("BEGIN");
  try {
    db.prepare(
      `INSERT INTO twin_runs (id, tenant_id, pursuit_id, proposal_version, mode, model_versions, panel_outputs, report, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      input.tenant,
      input.pursuitId ?? null,
      input.proposalVersion ?? null,
      input.report.mode,
      JSON.stringify(input.report.modelVersions),
      JSON.stringify({ findings: input.report.findings, ratings: input.report.ratings, scheme: input.report.scheme }),
      JSON.stringify(input.report),
      input.actor,
      created_at,
    );
    const insertFinding = db.prepare(
      `INSERT INTO twin_findings (id, run_id, tenant_id, factor, class, criterion_ref, proposal_quote, quote_verified, reasoning, suggested_fix, precedent_refs, user_disposition)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
    );
    for (const finding of input.report.findings) {
      insertFinding.run(
        finding.id,
        id,
        input.tenant,
        finding.factor,
        finding.class,
        finding.criterionId,
        finding.proposalQuote,
        finding.quoteVerified ? 1 : 0,
        finding.reasoning,
        finding.suggestedFix,
        JSON.stringify(finding.precedentRefs),
      );
    }
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
  return { id, tenant_id: input.tenant, pursuit_id: input.pursuitId ?? null, created_by: input.actor, created_at };
}

export function listTwinRuns(tenant: string, limit = 20): (StoredRun & { mode: string })[] {
  const rows = getDb()
    .prepare("SELECT id, tenant_id, pursuit_id, created_by, created_at, mode FROM twin_runs WHERE tenant_id = ? ORDER BY created_at DESC LIMIT ?")
    .all(tenant, Math.min(100, Math.max(1, limit))) as Record<string, unknown>[];
  return rows.map((row) => ({
    id: String(row.id),
    tenant_id: String(row.tenant_id),
    pursuit_id: row.pursuit_id ? String(row.pursuit_id) : null,
    created_by: String(row.created_by),
    created_at: String(row.created_at),
    mode: String(row.mode),
  }));
}

export function getTwinRun(tenant: string, id: string): TwinReport {
  const row = getDb().prepare("SELECT report FROM twin_runs WHERE id = ? AND tenant_id = ?").get(id, tenant) as { report: string } | undefined;
  if (!row) throw new ForensicsError("not_found", "Twin run not found.");
  return parseJson<TwinReport>(row.report, {
    mode: "deterministic-rubric",
    modelVersions: [],
    findings: [],
    discarded: [],
    ratings: [],
    scheme: [],
    factors: [],
    disclaimer: "",
    created_at: "",
  });
}

export function setFindingDisposition(tenant: string, findingId: string, disposition: "helpful" | "wrong" | "missed" | null, runId?: string): void {
  const result = getDb()
    .prepare(
      `UPDATE twin_findings SET user_disposition = ?
       WHERE tenant_id = ? AND id = ?
         AND run_id = COALESCE(?, (SELECT run_id FROM twin_findings WHERE tenant_id = ? AND id = ? ORDER BY rowid DESC LIMIT 1))`,
    )
    .run(disposition, tenant, findingId, runId ?? null, tenant, findingId);
  if (Number(result.changes) === 0) throw new ForensicsError("not_found", "Finding not found.");
}

export function saveDebriefRun(input: { tenant: string; actor: string; pursuitId?: string; documentId: string; report: ForensicsReport }): StoredRun {
  const db = getDb();
  const id = randomUUID();
  const created_at = new Date().toISOString();
  db.prepare(
    `INSERT INTO debrief_runs (id, tenant_id, pursuit_id, debrief_document_id, report, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, input.tenant, input.pursuitId ?? null, input.documentId, JSON.stringify(input.report), input.actor, created_at);
  const insertFinding = db.prepare(
    `INSERT INTO debrief_findings (id, run_id, tenant_id, text, linked_criterion, verification, proposal_quote, quote_verified, indicators, ground_refs, materiality)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const finding of input.report.findings) {
    insertFinding.run(
      `${id}:${finding.id}`,
      id,
      input.tenant,
      finding.text,
      finding.criterionId,
      finding.verification,
      finding.proposalQuote,
      finding.quoteVerified ? 1 : 0,
      JSON.stringify(finding.indicators),
      JSON.stringify(finding.groundRefs),
      finding.materiality,
    );
  }
  return { id, tenant_id: input.tenant, pursuit_id: input.pursuitId ?? null, created_by: input.actor, created_at };
}

export function getDebriefRun(tenant: string, id: string): ForensicsReport {
  const row = getDb().prepare("SELECT report FROM debrief_runs WHERE id = ? AND tenant_id = ?").get(id, tenant) as { report: string } | undefined;
  if (!row) throw new ForensicsError("not_found", "Debrief run not found.");
  return parseJson<ForensicsReport>(row.report, {
    findings: [],
    issues: [],
    consistency: [],
    disparateTreatment: { assessed: false, reason: "" },
    discardedQuotes: [],
    summary: [],
    disclaimer: "",
    standardOfReview: "",
    created_at: "",
  });
}

export function listDebriefRuns(tenant: string, limit = 20): (StoredRun & { document_id: string })[] {
  const rows = getDb()
    .prepare("SELECT id, tenant_id, pursuit_id, created_by, created_at, debrief_document_id FROM debrief_runs WHERE tenant_id = ? ORDER BY created_at DESC LIMIT ?")
    .all(tenant, Math.min(100, Math.max(1, limit))) as Record<string, unknown>[];
  return rows.map((row) => ({
    id: String(row.id),
    tenant_id: String(row.tenant_id),
    pursuit_id: row.pursuit_id ? String(row.pursuit_id) : null,
    created_by: String(row.created_by),
    created_at: String(row.created_at),
    document_id: String(row.debrief_document_id),
  }));
}

// ---------------------------------------------------------------- clocks

export function saveClock(input: { tenant: string; actor: string; pursuitId: string; clock: ProtestClock }): { id: string } {
  const id = randomUUID();
  getDb()
    .prepare(
      `INSERT INTO protest_clocks (id, tenant_id, pursuit_id, notice_date, computed_deadlines_json, rule_sources_json, acknowledged_by, acknowledged_at, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?)`,
    )
    .run(id, input.tenant, input.pursuitId, input.clock.noticeDate, JSON.stringify(input.clock), JSON.stringify(input.clock.ruleSources), input.actor, new Date().toISOString());
  return { id };
}

export function getClock(tenant: string, id: string): ProtestClock {
  const row = getDb().prepare("SELECT computed_deadlines_json FROM protest_clocks WHERE id = ? AND tenant_id = ?").get(id, tenant) as { computed_deadlines_json: string } | undefined;
  if (!row) throw new ForensicsError("not_found", "Protest clock not found.");
  return parseJson<ProtestClock>(row.computed_deadlines_json, {
    noticeDate: "",
    controllingFilingDeadline: null,
    deadlines: [],
    ruleSources: [],
    disclaimer: "",
    computedAt: "",
  });
}

export function listClocks(tenant: string, pursuitId?: string): { id: string; pursuit_id: string; clock: ProtestClock; acknowledged: boolean }[] {
  const db = getDb();
  const rows = pursuitId
    ? (db.prepare("SELECT id, pursuit_id, computed_deadlines_json, acknowledged_by FROM protest_clocks WHERE tenant_id = ? AND pursuit_id = ? ORDER BY created_at DESC").all(tenant, pursuitId) as Record<string, unknown>[])
    : (db.prepare("SELECT id, pursuit_id, computed_deadlines_json, acknowledged_by FROM protest_clocks WHERE tenant_id = ? ORDER BY created_at DESC").all(tenant) as Record<string, unknown>[]);
  return rows.map((row) => ({
    id: String(row.id),
    pursuit_id: String(row.pursuit_id),
    clock: parseJson<ProtestClock>(String(row.computed_deadlines_json ?? ""), {
      noticeDate: "",
      controllingFilingDeadline: null,
      deadlines: [],
      ruleSources: [],
      disclaimer: "",
      computedAt: "",
    }),
    acknowledged: Boolean(row.acknowledged_by),
  }));
}

export function acknowledgeClock(tenant: string, id: string, actor: string): void {
  const result = getDb()
    .prepare("UPDATE protest_clocks SET acknowledged_by = ?, acknowledged_at = ? WHERE id = ? AND tenant_id = ?")
    .run(actor, new Date().toISOString(), id, tenant);
  if (Number(result.changes) === 0) throw new ForensicsError("not_found", "Protest clock not found.");
}

// ---------------------------------------------------------------- calibration

export function saveCalibration(tenant: string, actor: string, runId: string | null, observations: CalibrationObservation[]): number {
  const statement = getDb().prepare(
    "INSERT INTO forensics_calibration (id, tenant_id, run_id, factor, predicted, actual, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  );
  const at = new Date().toISOString();
  let written = 0;
  for (const observation of observations) {
    statement.run(randomUUID(), tenant, runId, observation.factor, observation.predicted, observation.actual, actor, at);
    written++;
  }
  return written;
}

export function calibrationObservations(tenant: string): CalibrationObservation[] {
  const rows = getDb()
    .prepare("SELECT factor, predicted, actual FROM forensics_calibration WHERE tenant_id = ?")
    .all(tenant) as { factor: string; predicted: string; actual: string }[];
  return rows.map((row) => ({
    factor: row.factor,
    predicted: row.predicted as CalibrationObservation["predicted"],
    actual: row.actual as CalibrationObservation["actual"],
  }));
}

/** Findings a caller marked as wrong, used to tune prompts, never shared. */
export function dispositionSummary(tenant: string): { disposition: string; count: number }[] {
  const rows = getDb()
    .prepare("SELECT COALESCE(user_disposition, 'unrated') AS disposition, COUNT(*) AS count FROM twin_findings WHERE tenant_id = ? GROUP BY COALESCE(user_disposition, 'unrated')")
    .all(tenant) as { disposition: string; count: number }[];
  return rows.map((row) => ({ disposition: row.disposition, count: Number(row.count) }));
}

export function debriefFindingRows(tenant: string, runId: string): DebriefFindingRecord[] {
  const rows = getDb().prepare("SELECT * FROM debrief_findings WHERE run_id = ? AND tenant_id = ? ORDER BY id").all(runId, tenant) as Record<string, unknown>[];
  return rows.map((row) => ({
    id: String(row.id),
    text: String(row.text),
    class: "weakness",
    rationale: String(row.text),
    criterionId: row.linked_criterion ? String(row.linked_criterion) : null,
    criterionText: null,
    verification: String(row.verification) as DebriefFindingRecord["verification"],
    proposalQuote: row.proposal_quote ? String(row.proposal_quote) : null,
    quoteVerified: Number(row.quote_verified) === 1,
    indicators: parseJson<DebriefFindingRecord["indicators"]>(String(row.indicators ?? ""), []),
    groundRefs: parseJson<DebriefFindingRecord["groundRefs"]>(String(row.ground_refs ?? ""), []),
    materiality: String(row.materiality) as DebriefFindingRecord["materiality"],
    suggestedQuestions: [],
  }));
}
