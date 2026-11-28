"use client";

// Evaluation Forensics panel: the document vault with its attestation gate, the
// Evaluator Twin, Debrief Forensics, the protest clock and the protest corpus.
// Everything displayed is record-based analysis; the not-legal-advice line is
// part of the surface, not a footer afterthought.

import { useCallback, useEffect, useState } from "react";
import { Pill } from "./ui-bits";

type Doc = { id: string; kind: string; filename: string; origin: string; protectiveOrder: boolean; createdAt: string };
type Hit = { decisionId: string; citation: string; url: string; ground: string | null; holding: string; outcome: string; decisionDate: string; passage: string };
type ClockDeadline = { id: string; label: string; dueDate: string; status: string; daysRemaining: number | null; ruleText: string; source: string; adjusted: boolean; note?: string };
type Clock = { noticeDate: string; controllingFilingDeadline: string | null; deadlines: ClockDeadline[]; disclaimer: string };
type TwinFinding = { id: string; factor: string; class: string; criterionText: string; proposalQuote: string; quoteVerified: boolean; reasoning: string; suggestedFix: string; precedentRefs: { citation: string; url: string }[] };
type TwinReport = { mode: string; findings: TwinFinding[]; discarded: { factor: string; class: string; quote: string; reason: string }[]; ratings: { factor: string; rating: string | null; basis: string }[]; scheme: string[]; disclaimer: string };
type DebriefFinding = { id: string; text: string; class: string; criterionId: string | null; verification: string; proposalQuote: string | null; quoteVerified: boolean; indicators: { kind: string; label: string; detail: string }[]; groundRefs: string[]; materiality: string; suggestedQuestions: string[] };
type DebriefReport = { findings: DebriefFinding[]; issues: { findingId: string; summary: string; grounds: string[]; materiality: string; precedentRefs: { citation: string; url: string }[] }[]; consistency: { kind: string; detail: string }[]; disparateTreatment: { assessed: boolean; reason: string }; discardedQuotes: { findingId: string; quote: string }[]; summary: string[]; disclaimer: string; standardOfReview: string };
type RunRow = { id: string; mode?: string; created_at: string; pursuit_id: string | null };
type Data = {
  documents: Doc[];
  twinRuns: RunRow[];
  debriefRuns: RunRow[];
  clocks: { id: string; pursuitId: string; acknowledged: boolean; clock: Clock; summary: string }[];
  corpus: { size: number; statistics: { ground: string; sustained: number; denied: number; dismissed: number; sample: number }[]; sources: string[] };
  calibration: { summary: string; dispositions: { disposition: string; count: number }[] };
  disclaimer: string;
  admin: boolean;
};

const verificationTone = (v: string) => (v === "contradicted" ? "err" : v === "supported" ? "ok" : v === "ambiguous" ? "warn" : "run");
const classTone = (c: string) => (c === "deficiency" ? "err" : c === "significant weakness" ? "warn" : c === "weakness" ? "warn" : "ok");
const materialityTone = (m: string) => (m === "high" ? "err" : m === "medium" ? "warn" : "run");

const ORIGINS = [
  ["offeror", "My own proposal"],
  ["offeror_counsel", "Held by our counsel"],
  ["agency_debrief", "Debriefing material from the agency"],
  ["agency_notice", "Agency notice"],
  ["awardee_at_debrief", "Awardee excerpts given at our debriefing"],
  ["public_decision", "Published decision"],
] as const;

export default function ForensicsPanel() {
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState<"twin" | "debrief" | "clock" | "corpus" | "vault">("twin");

  const [upload, setUpload] = useState({
    kind: "proposal",
    filename: "",
    text: "",
    origin: "offeror",
    basis: "",
    attestedBy: "",
    protectiveOrder: false,
    authority: "",
    authorizedUnderOrder: false,
  });
  const [twinForm, setTwinForm] = useState({ proposalDocumentId: "", rfpDocumentId: "" });
  const [twin, setTwin] = useState<TwinReport | null>(null);
  const [debriefForm, setDebriefForm] = useState({ proposalDocumentId: "", debriefDocumentId: "", rfpDocumentId: "", awardeeExcerptDocumentId: "" });
  const [debrief, setDebrief] = useState<DebriefReport | null>(null);
  const [debriefRunId, setDebriefRunId] = useState<string | null>(null);
  const [clockForm, setClockForm] = useState({ noticeDate: "", debriefDate: "", proposalsDueDate: "", pursuitId: "" });
  const [clock, setClock] = useState<Clock | null>(null);
  const [corpusQuery, setCorpusQuery] = useState("");
  const [corpusGround, setCorpusGround] = useState("");
  const [hits, setHits] = useState<Hit[]>([]);
  const [ingest, setIngest] = useState({ url: "", citation: "", text: "" });
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/forensics");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setData((await res.json()) as Data);
      setError(null);
    } catch {
      setError("Could not reach the forensics API.");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const op = useCallback(async (body: Record<string, unknown>): Promise<Record<string, unknown>> => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/forensics", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const json = (await res.json().catch(() => ({}))) as { error?: { message?: string } } & Record<string, unknown>;
      if (!res.ok) throw new Error(json.error?.message ?? `Operation failed (HTTP ${res.status})`);
      await load();
      return json;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Operation failed");
      throw err;
    } finally {
      setBusy(false);
    }
  }, [load]);

  const docs = data?.documents ?? [];
  const proposals = docs.filter((d) => d.kind === "proposal");
  const rfps = docs.filter((d) => d.kind === "rfp");
  const debriefDocs = docs.filter((d) => d.kind === "debrief");
  const awardeeDocs = docs.filter((d) => d.kind === "awardee_excerpt");

  const submitUpload = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await op({
        op: "upload",
        kind: upload.kind,
        filename: upload.filename || `${upload.kind}.txt`,
        text: upload.text,
        attestation: {
          authorized: true,
          origin: upload.origin,
          basis: upload.basis,
          attestedBy: upload.attestedBy,
          protectiveOrder: upload.protectiveOrder,
          protectiveOrderAuthority: upload.protectiveOrder ? upload.authority : undefined,
          authorizedUnderOrder: upload.protectiveOrder ? upload.authorizedUnderOrder : undefined,
        },
      });
      setUpload({ ...upload, filename: "", text: "", basis: "" });
      setNotice("Document stored under the attestation you signed.");
    } catch {
      /* error surfaced */
    }
  };

  return (
    <div className="gp-stack">
      <header className="gp-card">
        <div>
          <h2>Evaluation Forensics</h2>
          <p className="gp-fineprint">Evaluator Twin before submission, debrief verification after award, protest clock and the public decision corpus.</p>
        </div>
        <div className="gp-row">
          <button className="gp-btn" onClick={() => void load()} disabled={busy}>Refresh</button>
          {data ? <Pill tone="run">{data.corpus.size} decisions</Pill> : null}
        </div>
      </header>

      {error ? <p className="gp-error" role="alert">{error}</p> : null}
      {notice ? <p className="gp-fineprint">{notice}</p> : null}
      <p className="gp-fineprint">{data?.disclaimer ?? "Not legal advice. Record-based analysis for counsel to review."}</p>

      <nav className="gp-row" aria-label="Forensics sections">
        {([
          ["twin", "Evaluator Twin"],
          ["debrief", "Debrief Forensics"],
          ["clock", "Protest clock"],
          ["corpus", "Corpus"],
          ["vault", "Documents"],
        ] as const).map(([id, label]) => (
          <button key={id} className={tab === id ? "gp-btn" : "gp-ghost"} onClick={() => setTab(id)} aria-pressed={tab === id}>
            {label}
          </button>
        ))}
      </nav>

      {tab === "vault" ? (
        <section className="gp-card" aria-labelledby="fx-vault">
          <h3 id="fx-vault">Document vault</h3>
          <p className="gp-fineprint">
            Every document needs an attestation bound to its content hash. Competitor proposals and source selection information are refused; protective-order material is tenant-locked and never enters the corpus.
          </p>
          <form className="gp-controls" onSubmit={submitUpload}>
            <label className="gp-field">
              <span className="gp-label">Kind</span>
              <select className="gp-select" value={upload.kind} onChange={(e) => setUpload({ ...upload, kind: e.target.value })}>
                <option value="proposal">Proposal</option>
                <option value="rfp">RFP</option>
                <option value="debrief">Debriefing material</option>
                <option value="awardee_excerpt">Awardee excerpts from our debriefing</option>
                <option value="other">Other</option>
              </select>
            </label>
            <label className="gp-field">
              <span className="gp-label">Origin</span>
              <select className="gp-select" value={upload.origin} onChange={(e) => setUpload({ ...upload, origin: e.target.value })}>
                {ORIGINS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
              </select>
            </label>
            <label className="gp-field gp-field-grow">
              <span className="gp-label">Filename</span>
              <input className="gp-input" value={upload.filename} onChange={(e) => setUpload({ ...upload, filename: e.target.value })} placeholder="technical-volume.pdf" />
            </label>
            <label className="gp-field gp-field-grow">
              <span className="gp-label">Attested by</span>
              <input className="gp-input" value={upload.attestedBy} onChange={(e) => setUpload({ ...upload, attestedBy: e.target.value })} placeholder="Your name" required />
            </label>
            <label className="gp-field gp-field-grow">
              <span className="gp-label">Why you may lawfully hold it (required, min 10 characters)</span>
              <input className="gp-input" value={upload.basis} onChange={(e) => setUpload({ ...upload, basis: e.target.value })} placeholder="Our own submitted proposal, April 2026" required />
            </label>
            <label className="gp-field">
              <span className="gp-label">Protective order</span>
              <div className="gp-row">
                <input type="checkbox" checked={upload.protectiveOrder} onChange={(e) => setUpload({ ...upload, protectiveOrder: e.target.checked })} aria-label="Under protective order" />
                <input className="gp-input" value={upload.authority} onChange={(e) => setUpload({ ...upload, authority: e.target.value })} placeholder="Order or case reference" disabled={!upload.protectiveOrder} />
              </div>
            </label>
            {upload.protectiveOrder ? (
              <label className="gp-row gp-fineprint">
                <input type="checkbox" checked={upload.authorizedUnderOrder} onChange={(e) => setUpload({ ...upload, authorizedUnderOrder: e.target.checked })} />
                I am authorized to hold this material under that order.
              </label>
            ) : null}
            <label className="gp-field gp-span">
              <span className="gp-label">Document text (paste; accepted only with the attestation above)</span>
              <textarea className="gp-textarea" rows={6} value={upload.text} onChange={(e) => setUpload({ ...upload, text: e.target.value })} placeholder="Paste the proposal, RFP or debrief text…" required />
            </label>
            <div className="gp-row">
              <button className="gp-btn" type="submit" disabled={busy}>Store with attestation</button>
            </div>
          </form>

          <div className="gp-list">
            {docs.length === 0 ? <p className="gp-fineprint">No documents yet.</p> : null}
            {docs.map((doc) => (
              <div key={doc.id} className="gp-row gp-history-row">
                <Pill tone="run">{doc.kind}</Pill>
                <span className="gp-mono">{doc.filename}</span>
                <span className="gp-fineprint">{doc.origin}</span>
                {doc.protectiveOrder ? <Pill tone="warn">protective order</Pill> : null}
                <span className="gp-fineprint">{doc.createdAt.slice(0, 16).replace("T", " ")}</span>
                <button className="gp-ghost gp-btn-sm" onClick={() => void op({ op: "delete-document", id: doc.id })} disabled={busy}>Delete</button>
              </div>
            ))}
          </div>
        </section>
      ) : null}

      {tab === "twin" ? (
        <section className="gp-card" aria-labelledby="fx-twin">
          <h3 id="fx-twin">Evaluator Twin</h3>
          <p className="gp-fineprint">
            An independent panel reads the draft against Section M only. Every finding must quote the proposal; a quote that does not exist is discarded and listed. Ratings come from the RFP&apos;s own scheme or are left blank.
          </p>
          <div className="gp-controls">
            <label className="gp-field gp-field-grow">
              <span className="gp-label">Draft proposal</span>
              <select className="gp-select" value={twinForm.proposalDocumentId} onChange={(e) => setTwinForm({ ...twinForm, proposalDocumentId: e.target.value })}>
                <option value="">Choose a proposal…</option>
                {proposals.map((d) => <option key={d.id} value={d.id}>{d.filename}</option>)}
              </select>
            </label>
            <label className="gp-field gp-field-grow">
              <span className="gp-label">RFP (Sections L and M)</span>
              <select className="gp-select" value={twinForm.rfpDocumentId} onChange={(e) => setTwinForm({ ...twinForm, rfpDocumentId: e.target.value })}>
                <option value="">Choose an RFP…</option>
                {rfps.map((d) => <option key={d.id} value={d.id}>{d.filename}</option>)}
              </select>
            </label>
            <button
              className="gp-btn"
              disabled={busy || !twinForm.proposalDocumentId || !twinForm.rfpDocumentId}
              onClick={async () => {
                try {
                  const res = await op({ op: "twin", proposalDocumentId: twinForm.proposalDocumentId, rfpDocumentId: twinForm.rfpDocumentId });
                  setTwin(res.report as TwinReport);
                } catch { /* surfaced */ }
              }}
            >
              {busy ? "Panel reading…" : "Run panel"}
            </button>
          </div>

          {twin ? (
            <>
              <p className="gp-fineprint">
                Mode: <strong>{twin.mode}</strong> · {twin.findings.length} finding(s) · {twin.discarded.length} discarded · scheme: {twin.scheme.length ? twin.scheme.join(" < ") : "not stated in the RFP"}
              </p>
              <div className="gp-grid">
                {twin.ratings.map((r) => (
                  <div key={r.factor} className="gp-block">
                    <div className="gp-block-head"><strong>{r.factor}</strong><Pill tone={r.rating ? "run" : "warn"}>{r.rating ?? "no rating"}</Pill></div>
                    <p className="gp-fineprint">{r.basis}</p>
                  </div>
                ))}
              </div>
              <div className="gp-list">
                {twin.findings.map((f) => (
                  <article key={f.id} className="gp-block">
                    <div className="gp-block-head">
                      <strong>{f.factor}</strong>
                      <Pill tone={classTone(f.class)}>{f.class}</Pill>
                      {f.quoteVerified ? <Pill tone="ok">quote verified</Pill> : <Pill tone="warn">absence finding</Pill>}
                    </div>
                    {f.proposalQuote ? <blockquote className="gp-pre">{f.proposalQuote}</blockquote> : null}
                    <p>{f.reasoning}</p>
                    <p className="gp-fineprint">Fix: {f.suggestedFix}</p>
                    {f.precedentRefs.length ? (
                      <p className="gp-fineprint">
                        Precedent: {f.precedentRefs.map((p) => p.citation).join("; ")}
                      </p>
                    ) : null}
                  </article>
                ))}
              </div>
              {twin.discarded.length ? (
                <div className="gp-alert gp-alert-warn">
                  <strong>Discarded for a quote that does not exist</strong>
                  <ul>
                    {twin.discarded.map((d, i) => <li key={i}>{d.factor}: “{d.quote.slice(0, 140)}” — {d.reason}</li>)}
                  </ul>
                </div>
              ) : null}
              <p className="gp-fineprint">{twin.disclaimer}</p>
            </>
          ) : null}
        </section>
      ) : null}

      {tab === "debrief" ? (
        <section className="gp-card" aria-labelledby="fx-debrief">
          <h3 id="fx-debrief">Debrief Forensics</h3>
          <p className="gp-fineprint">Each recorded finding is checked against your own proposal text. Quotes shown beside a finding exist verbatim in the source.</p>
          <div className="gp-controls">
            <label className="gp-field gp-field-grow">
              <span className="gp-label">Our proposal</span>
              <select className="gp-select" value={debriefForm.proposalDocumentId} onChange={(e) => setDebriefForm({ ...debriefForm, proposalDocumentId: e.target.value })}>
                <option value="">Choose…</option>
                {proposals.map((d) => <option key={d.id} value={d.id}>{d.filename}</option>)}
              </select>
            </label>
            <label className="gp-field gp-field-grow">
              <span className="gp-label">Debriefing material</span>
              <select className="gp-select" value={debriefForm.debriefDocumentId} onChange={(e) => setDebriefForm({ ...debriefForm, debriefDocumentId: e.target.value })}>
                <option value="">Choose…</option>
                {debriefDocs.map((d) => <option key={d.id} value={d.id}>{d.filename}</option>)}
              </select>
            </label>
            <label className="gp-field gp-field-grow">
              <span className="gp-label">RFP</span>
              <select className="gp-select" value={debriefForm.rfpDocumentId} onChange={(e) => setDebriefForm({ ...debriefForm, rfpDocumentId: e.target.value })}>
                <option value="">Choose…</option>
                {rfps.map((d) => <option key={d.id} value={d.id}>{d.filename}</option>)}
              </select>
            </label>
            <label className="gp-field gp-field-grow">
              <span className="gp-label">Awardee excerpts (optional, only if lawfully held)</span>
              <select className="gp-select" value={debriefForm.awardeeExcerptDocumentId} onChange={(e) => setDebriefForm({ ...debriefForm, awardeeExcerptDocumentId: e.target.value })}>
                <option value="">None</option>
                {awardeeDocs.map((d) => <option key={d.id} value={d.id}>{d.filename}</option>)}
              </select>
            </label>
            <button
              className="gp-btn"
              disabled={busy || !debriefForm.proposalDocumentId || !debriefForm.debriefDocumentId || !debriefForm.rfpDocumentId}
              onClick={async () => {
                try {
                  const res = await op({
                    op: "debrief",
                    proposalDocumentId: debriefForm.proposalDocumentId,
                    debriefDocumentId: debriefForm.debriefDocumentId,
                    rfpDocumentId: debriefForm.rfpDocumentId,
                    awardeeExcerptDocumentId: debriefForm.awardeeExcerptDocumentId || undefined,
                  });
                  setDebrief(res.report as DebriefReport);
                  setDebriefRunId(String(res.runId ?? ""));
                } catch { /* surfaced */ }
              }}
            >
              {busy ? "Verifying…" : "Verify findings"}
            </button>
          </div>

          {debrief ? (
            <>
              <ul className="gp-fineprint">
                {debrief.summary.map((line, i) => <li key={i}>{line}</li>)}
              </ul>
              <div className="gp-row">
                <button
                  className="gp-btn"
                  disabled={busy || !debriefRunId}
                  onClick={async () => {
                    try {
                      const res = await op({ op: "export-counsel", debriefRunId });
                      setNotice(`Counsel package planned as transaction ${String(res.transactionId)} — approve it in Govern to write the file.`);
                    } catch { /* surfaced */ }
                  }}
                >
                  Plan counsel export (approval gate)
                </button>
                <span className="gp-fineprint">{debrief.disparateTreatment.reason}</span>
              </div>

              <h4>Finding-by-finding verification</h4>
              <div className="gp-list">
                {debrief.findings.map((f) => (
                  <article key={f.id} className="gp-block">
                    <div className="gp-block-head">
                      <Pill tone={classTone(f.class)}>{f.class}</Pill>
                      <Pill tone={verificationTone(f.verification)}>{f.verification}</Pill>
                      <Pill tone={materialityTone(f.materiality)}>{f.materiality} materiality</Pill>
                      <span className="gp-fineprint">{f.criterionId ?? "no stated criterion"}</span>
                    </div>
                    <p>{f.text}</p>
                    {f.proposalQuote ? <blockquote className="gp-pre">Proposal: {f.proposalQuote}</blockquote> : null}
                    {f.indicators.length ? (
                      <ul className="gp-fineprint">
                        {f.indicators.map((ind, i) => <li key={i}><strong>{ind.label}:</strong> {ind.detail}</li>)}
                      </ul>
                    ) : null}
                    {f.suggestedQuestions.length ? (
                      <p className="gp-fineprint">Ask: {f.suggestedQuestions.join(" ")}</p>
                    ) : null}
                  </article>
                ))}
              </div>

              {debrief.issues.length ? (
                <>
                  <h4>Issue list for counsel (ordered by materiality)</h4>
                  <div className="gp-list">
                    {debrief.issues.map((issue) => (
                      <div key={issue.findingId} className="gp-row gp-history-row">
                        <Pill tone={materialityTone(issue.materiality)}>{issue.materiality}</Pill>
                        <span className="gp-text">{issue.summary}</span>
                        <span className="gp-fineprint">{issue.grounds.join(", ")}</span>
                        <span className="gp-fineprint">{issue.precedentRefs.map((p) => p.citation).join("; ")}</span>
                      </div>
                    ))}
                  </div>
                </>
              ) : null}

              {debrief.consistency.length ? (
                <div className="gp-alert gp-alert-warn">
                  <strong>Consistency checks</strong>
                  <ul>{debrief.consistency.map((c, i) => <li key={i}>{c.detail}</li>)}</ul>
                </div>
              ) : null}

              {debrief.discardedQuotes.length ? (
                <div className="gp-alert gp-alert-err">
                  <strong>Quotes attributed to the proposal that do not exist in it</strong>
                  <ul>{debrief.discardedQuotes.map((d, i) => <li key={i}>{d.findingId}: “{d.quote.slice(0, 160)}”</li>)}</ul>
                </div>
              ) : null}

              <p className="gp-fineprint">{debrief.standardOfReview}</p>
              <p className="gp-fineprint">{debrief.disclaimer}</p>
            </>
          ) : null}
        </section>
      ) : null}

      {tab === "clock" ? (
        <section className="gp-card" aria-labelledby="fx-clock">
          <h3 id="fx-clock">Protest clock</h3>
          <p className="gp-fineprint">Every date carries its rule text and source, is adjusted to the next business day, and is marked verify-with-counsel.</p>
          <div className="gp-controls">
            <label className="gp-field">
              <span className="gp-label">Notice date</span>
              <input className="gp-input" type="date" value={clockForm.noticeDate} onChange={(e) => setClockForm({ ...clockForm, noticeDate: e.target.value })} />
            </label>
            <label className="gp-field">
              <span className="gp-label">Debriefing held</span>
              <input className="gp-input" type="text" inputMode="numeric" maxLength={10} placeholder="YYYY-MM-DD" value={clockForm.debriefDate} onChange={(e) => setClockForm({ ...clockForm, debriefDate: e.target.value })} />
            </label>
            <label className="gp-field">
              <span className="gp-label">Proposals due (terms challenge)</span>
              <input className="gp-input" type="text" inputMode="numeric" maxLength={10} placeholder="YYYY-MM-DD" value={clockForm.proposalsDueDate} onChange={(e) => setClockForm({ ...clockForm, proposalsDueDate: e.target.value })} />
            </label>
            <label className="gp-field gp-field-grow">
              <span className="gp-label">Pursuit</span>
              <input className="gp-input" value={clockForm.pursuitId} onChange={(e) => setClockForm({ ...clockForm, pursuitId: e.target.value })} placeholder="Pursuit id, for saved clocks" />
            </label>
            <button
              className="gp-btn"
              disabled={busy || !clockForm.noticeDate}
              onClick={async () => {
                try {
                  const res = await op({
                    op: "clock",
                    noticeDate: clockForm.noticeDate,
                    debriefDate: clockForm.debriefDate || undefined,
                    proposalsDueDate: clockForm.proposalsDueDate || undefined,
                    pursuitId: clockForm.pursuitId || "pursuit",
                    save: Boolean(clockForm.pursuitId),
                  });
                  setClock(res.clock as Clock);
                } catch { /* surfaced */ }
              }}
            >
              Compute
            </button>
          </div>

          {clock ? (
            <>
              <p className="gp-fineprint">Controlling filing deadline: <strong>{clock.controllingFilingDeadline ?? "—"}</strong></p>
              <div className="gp-list">
                {clock.deadlines.map((d) => (
                  <div key={d.id} className="gp-row gp-history-row">
                    <Pill tone={d.status === "passed" ? "err" : d.status === "due_soon" ? "warn" : "run"}>{d.status.replace("_", " ")}</Pill>
                    <span className="gp-text">{d.label}</span>
                    <span className="gp-mono">{d.dueDate || "—"}</span>
                    <span className="gp-fineprint">{d.daysRemaining === null ? d.note ?? "" : `${d.daysRemaining} day(s)`}</span>
                    <p className="gp-fineprint">
                      {d.source} — {d.ruleText}
                      {d.adjusted ? " Adjusted to the next business day." : ""}
                    </p>
                  </div>
                ))}
              </div>
              <p className="gp-fineprint">{clock.disclaimer}</p>
            </>
          ) : null}

          <h4>Saved clocks</h4>
          <div className="gp-list">
            {(data?.clocks ?? []).map((row) => (
              <div key={row.id} className="gp-row gp-history-row">
                <span className="gp-mono">{row.pursuitId}</span>
                <span className="gp-text">{row.summary}</span>
                {row.acknowledged ? <Pill tone="ok">acknowledged</Pill> : <button className="gp-ghost gp-btn-sm" onClick={() => void op({ op: "clock-ack", id: row.id })} disabled={busy}>Acknowledge</button>}
              </div>
            ))}
          </div>
        </section>
      ) : null}

      {tab === "corpus" ? (
        <section className="gp-card" aria-labelledby="fx-corpus">
          <h3 id="fx-corpus">Protest Intelligence corpus</h3>
          <p className="gp-fineprint">Public GAO and Court of Federal Claims decisions only, ingested from official sources. Every hit carries its citation, link and the passage behind the match.</p>
          <div className="gp-controls">
            <label className="gp-field gp-field-grow">
              <span className="gp-label">What happened</span>
              <input className="gp-input" value={corpusQuery} onChange={(e) => setCorpusQuery(e.target.value)} placeholder="weakness for content the solicitation did not require" />
            </label>
            <label className="gp-field">
              <span className="gp-label">Ground</span>
              <select className="gp-select" value={corpusGround} onChange={(e) => setCorpusGround(e.target.value)}>
                <option value="">Any</option>
                {(data?.corpus.statistics ?? []).map((s) => <option key={s.ground} value={s.ground}>{s.ground.replace(/_/g, " ")}</option>)}
              </select>
            </label>
            <button
              className="gp-btn"
              disabled={busy || corpusQuery.trim().length < 3}
              onClick={async () => {
                try {
                  const res = await op({ op: "precedent", query: corpusQuery, ground: corpusGround || undefined, limit: 10 });
                  setHits((res.hits as Hit[]) ?? []);
                } catch { /* surfaced */ }
              }}
            >
              Search
            </button>
          </div>

          <div className="gp-grid">
            {(data?.corpus.statistics ?? []).map((s) => (
              <div key={s.ground} className="gp-block">
                <div className="gp-block-head"><strong>{s.ground.replace(/_/g, " ")}</strong><Pill tone="run">n={s.sample}</Pill></div>
                <p className="gp-fineprint">sustained {s.sustained} · denied {s.denied} · dismissed {s.dismissed}</p>
              </div>
            ))}
          </div>

          <div className="gp-list">
            {hits.map((hit) => (
              <article key={hit.decisionId} className="gp-block">
                <div className="gp-block-head">
                  <strong>{hit.citation}</strong>
                  <Pill tone={hit.holding === "sustained" ? "ok" : hit.holding === "denied" ? "err" : "warn"}>{hit.holding}</Pill>
                  <span className="gp-fineprint">{hit.decisionDate} · {hit.ground?.replace(/_/g, " ") ?? "no ground"}</span>
                </div>
                <p className="gp-text">{hit.passage}</p>
                {hit.url ? <a className="gp-fineprint" href={hit.url} target="_blank" rel="noreferrer">Open the decision</a> : null}
              </article>
            ))}
          </div>

          {data?.admin ? (
            <div className="gp-block">
              <h4>Ingest a published decision (admin)</h4>
              <div className="gp-controls">
                <label className="gp-field gp-field-grow">
                  <span className="gp-label">Official URL (gao.gov or uscfc.uscourts.gov)</span>
                  <input className="gp-input" value={ingest.url} onChange={(e) => setIngest({ ...ingest, url: e.target.value })} />
                </label>
                <label className="gp-field gp-field-grow">
                  <span className="gp-label">Citation (optional)</span>
                  <input className="gp-input" value={ingest.citation} onChange={(e) => setIngest({ ...ingest, citation: e.target.value })} placeholder="B-421234, Jan. 5, 2026" />
                </label>
                <button
                  className="gp-btn"
                  disabled={busy}
                  onClick={async () => {
                    try {
                      await op({ op: "ingest-decision", url: ingest.url || undefined, citation: ingest.citation || undefined });
                      setNotice("Decision ingested with a versioned extraction.");
                    } catch { /* surfaced */ }
                  }}
                >
                  Ingest
                </button>
              </div>
              <p className="gp-fineprint">Approved sources: {(data?.corpus.sources ?? []).join(", ")}.</p>
            </div>
          ) : null}
        </section>
      ) : null}

      <section className="gp-card" aria-labelledby="fx-cal">
        <h3 id="fx-cal">Calibration</h3>
        <p className="gp-fineprint">{data?.calibration.summary ?? "No back-test observations recorded."}</p>
        <div className="gp-row">
          {(data?.calibration.dispositions ?? []).map((d) => <Pill key={d.disposition} tone="run">{d.disposition}: {d.count}</Pill>)}
        </div>
        <p className="gp-fineprint">Agreement is reported per factor with its sample size; a small sample is labeled as such, never turned into a rate.</p>
      </section>
    </div>
  );
}
