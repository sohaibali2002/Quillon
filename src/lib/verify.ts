// Work verification engine: Quillon doesn't just produce documents, it checks
// them. Verifiers run structural, consistency and quality checks per document
// type and produce an auditable report (pass / warn / fail per check).
//
// Spreadsheet checks operate on a real workbook parser: ExcelJS reads the
// uploaded .xlsx and the checks inspect formulas, references and hardcodes.
import { randomUUID } from "node:crypto";
import { getDb } from "@/lib/db";

export interface Check {
  id: string;
  name: string;
  verdict: "pass" | "warn" | "fail";
  detail: string;
  locations?: string[];
}

export interface VerificationReport {
  id: string;
  targetKind: "xlsx" | "docx" | "pptx" | "research";
  targetName: string;
  verdict: "pass" | "warn" | "fail";
  checks: Check[];
  created_at: string;
}

function overall(checks: Check[]): Check["verdict"] {
  if (checks.some((c) => c.verdict === "fail")) return "fail";
  if (checks.some((c) => c.verdict === "warn")) return "warn";
  return "pass";
}

export function saveReport(targetKind: VerificationReport["targetKind"], targetName: string, checks: Check[], org = "default"): VerificationReport {
  const id = randomUUID();
  const verdict = overall(checks);
  getDb()
    .prepare("INSERT INTO verification_reports (id, org, target_kind, target_name, verdict, checks) VALUES (?, ?, ?, ?, ?, ?)")
    .run(id, org, targetKind, targetName, verdict, JSON.stringify(checks));
  return { id, targetKind, targetName, verdict, checks, created_at: new Date().toISOString() };
}

export function listReports(limit = 50) {
  return (
    getDb()
      .prepare("SELECT * FROM verification_reports ORDER BY created_at DESC LIMIT ?")
      .all(limit) as Record<string, unknown>[]
  ).map((r) => ({
    id: String(r.id),
    targetKind: String(r.target_kind),
    targetName: String(r.target_name),
    verdict: String(r.verdict),
    checks: JSON.parse(String(r.checks)) as Check[],
    created_at: String(r.created_at),
  }));
}

// --- Spreadsheet verification ------------------------------------------------

export interface SheetSummary {
  name: string;
  formulas: string[];
  literals: string[];
  brokenRefs: string[];
}

export function verifySpreadsheet(summary: SheetSummary[]): Check[] {
  const checks: Check[] = [];
  // Broken references (#REF!, #NAME?, #VALUE!) anywhere.
  const broken = summary.flatMap((s) => s.brokenRefs.map((ref) => `${s.name}!${ref}`));
  checks.push({
    id: "xlsx-broken-refs",
    name: "No broken cell references",
    verdict: broken.length ? "fail" : "pass",
    detail: broken.length ? `${broken.length} broken reference(s) found` : "No #REF!/#NAME?/#VALUE! errors.",
    locations: broken.slice(0, 10),
  });

  // Hardcoded values inside formula-driven regions: a cell that mixes a literal
  // into a column that is otherwise formulas usually means someone pasted over
  // a formula. Flagged as a warning, not a failure.
  const hardcoded: string[] = [];
  for (const s of summary) {
    const byColumn = new Map<string, { formulas: number; literals: number }>();
    for (const cell of [...s.formulas, ...s.literals]) {
      const m = /^([A-Z]+)(\d+)$/.exec(cell);
      if (!m) continue;
      const col = byColumn.get(m[1]) ?? { formulas: 0, literals: 0 };
      if (s.formulas.includes(cell)) col.formulas++;
      else col.literals++;
      byColumn.set(m[1], col);
    }
    for (const [col, c] of byColumn) {
      if (c.formulas >= 3 && c.literals > 0) hardcoded.push(`${s.name}!${col} (${c.literals} literal(s) among ${c.formulas} formulas)`);
    }
  }
  checks.push({
    id: "xlsx-hardcodes",
    name: "No hardcoded values inside formula regions",
    verdict: hardcoded.length ? "warn" : "pass",
    detail: hardcoded.length ? "Literal cells found in formula-driven columns" : "Formula columns are clean.",
    locations: hardcoded.slice(0, 10),
  });

  // Formula consistency: identical formulas should differ only by row. A column
  // where one formula diverges from its neighbours is a classic error — callers
  // run verifyFormulaConsistency() over the parsed formula texts for that check.

  // Balance check: at least one sheet should exist when verifying financials.
  checks.push({
    id: "xlsx-structure",
    name: "Workbook has readable sheets",
    verdict: summary.length ? "pass" : "fail",
    detail: summary.length ? `${summary.length} sheet(s) parsed.` : "No sheets could be parsed.",
  });
  return checks;
}

// Formula-consistency check over full formula texts (cell ref -> formula body).
export function verifyFormulaConsistency(byColumn: Record<string, { ref: string; body: string }[]>): Check[] {
  const issues: string[] = [];
  for (const [col, cells] of Object.entries(byColumn)) {
    if (cells.length < 4) continue;
    const normalize = (body: string) => body.replace(/(\$?[A-Z]{1,3}\$?)\d+/g, "$1#");
    const bodies = cells.map((c) => normalize(c.body));
    const counts = new Map<string, number>();
    for (const b of bodies) counts.set(b, (counts.get(b) ?? 0) + 1);
    const majority = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
    if (majority[1] >= cells.length - 1) {
      for (let i = 0; i < bodies.length; i++) {
        if (bodies[i] !== majority[0]) {
          issues.push(`${col}${cells[i].ref} deviates: ${cells[i].body}`);
        }
      }
    }
  }
  return [{
    id: "xlsx-formula-consistency",
    name: "Column formulas are consistent",
    verdict: issues.length ? "warn" : "pass",
    detail: issues.length ? `${issues.length} formula(s) deviate from the column pattern` : "All formula columns follow one pattern.",
    locations: issues.slice(0, 10),
  }];
}

// --- Presentation verification -------------------------------------------------

export interface DeckSummary {
  slides: { index: number; fonts: string[]; overflow: boolean; titles: string[] }[];
}

export function verifyDeck(deck: DeckSummary): Check[] {
  const fonts = [...new Set(deck.slides.flatMap((s) => s.fonts))];
  const checks: Check[] = [];
  checks.push({
    id: "pptx-font-consistency",
    name: "Consistent fonts across slides",
    verdict: fonts.length <= 2 ? "pass" : "warn",
    detail: fonts.length <= 2 ? `${fonts.length} font(s) used.` : `${fonts.length} fonts used; brand kits usually allow two.`,
    locations: fonts,
  });
  const overflowed = deck.slides.filter((s) => s.overflow).map((s) => `slide ${s.index}`);
  checks.push({
    id: "pptx-overflow",
    name: "No overflowing text",
    verdict: overflowed.length ? "fail" : "pass",
    detail: overflowed.length ? `${overflowed.length} slide(s) overflow their placeholders` : "All text fits.",
    locations: overflowed,
  });
  const untitled = deck.slides.filter((s) => !s.titles.length).map((s) => `slide ${s.index}`);
  checks.push({
    id: "pptx-titles",
    name: "Every slide has a title",
    verdict: untitled.length ? "warn" : "pass",
    detail: untitled.length ? `${untitled.length} slide(s) without a title` : "All slides titled.",
    locations: untitled,
  });
  return checks;
}

// --- Document (Word) verification ----------------------------------------------

export interface DocSummary {
  headings: string[];
  words: number;
  citationCount: number;
  dates: string[];
}

export function verifyDocument(doc: DocSummary): Check[] {
  const checks: Check[] = [];
  checks.push({
    id: "docx-citations",
    name: "Claims carry citations",
    verdict: doc.citationCount > 0 ? "pass" : "warn",
    detail: doc.citationCount > 0 ? `${doc.citationCount} citation(s) found.` : "No citations found; unsupported claims may exist.",
  });
  checks.push({
    id: "docx-structure",
    name: "Document has heading structure",
    verdict: doc.headings.length > 0 ? "pass" : "warn",
    detail: doc.headings.length > 0 ? `${doc.headings.length} heading(s).` : "No headings; the document may lack structure.",
  });
  // Contradictory dates: same day written in two different formats is fine, but
  // mutually exclusive years in a plan (e.g. 2024 vs 2030 for one milestone)
  // cannot be inferred structurally — surface the dates for review instead.
  const years = [...new Set(doc.dates.map((d) => d.slice(0, 4)).filter(Boolean))];
  checks.push({
    id: "docx-dates",
    name: "Dates are consistent",
    verdict: years.length <= 1 ? "pass" : "warn",
    detail: years.length <= 1 ? "Single year referenced." : `Multiple years referenced (${years.join(", ")}); confirm they are intentional.`,
    locations: years,
  });
  return checks;
}
