// Document studio: the standard template catalog and branded generation.
//
// Every builtin template is a typed generator that pulls palette, type and
// masthead from the selected brand kit (themeFromKit), so a deck generated
// for Acme is unmistakably Acme's.

import { buildOffice, themeFromKit, type BrandTheme } from "@/lib/office";
import { getKit } from "@/lib/brand";

export type StudioInput = Record<string, string>;

export type BuiltinTemplate = {
  id: string;
  name: string;
  kind: "pptx" | "docx" | "xlsx";
  category: "decks" | "documents" | "workbooks";
  description: string;
  fields: { key: string; label: string; placeholder: string; multiline?: boolean }[];
  generate: (input: StudioInput, theme: BrandTheme) => Promise<
    { ok: true; filename: string; bytes: number; fileDataUrl: string } | { ok: false; error: string }
  >;
};

const lines = (s?: string): string[] =>
  (s ?? "")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

export const builtinTemplates: BuiltinTemplate[] = [
  {
    id: "pitch-deck",
    name: "Pitch deck",
    kind: "pptx",
    category: "decks",
    description: "Problem, solution, market, traction, ask — the standard ten-slide investor story.",
    fields: [
      { key: "company", label: "Company", placeholder: "Northwind Robotics" },
      { key: "problem", label: "Problem", placeholder: "Warehouse picking is slow and error-prone", multiline: true },
      { key: "solution", label: "Solution", placeholder: "Autonomous mobile pickers with 99.9% accuracy", multiline: true },
      { key: "traction", label: "Traction (one per line)", placeholder: "$1.2M ARR\n38 customers\n112% NRR", multiline: true },
      { key: "ask", label: "Ask", placeholder: "$8M Series A" },
    ],
    generate: async (i, t) =>
      buildOffice(
        {
          kind: "pptx",
          filename: `${i.company || "company"}-pitch.pptx`,
          slides: [
            { title: i.company || "Company", bullets: [i.solution || ""].filter(Boolean), notes: "Opening slide: company and one-line positioning." },
            { title: "The problem", bullets: lines(i.problem), notes: "Anchor the pain before the product." },
            { title: "Our solution", bullets: lines(i.solution) },
            { title: "Traction", bullets: lines(i.traction), notes: "Numbers with context — growth rate, retention." },
            { title: "The ask", bullets: [i.ask].filter(Boolean) },
          ],
        },
        t,
      ),
  },
  {
    id: "status-deck",
    name: "Project status deck",
    kind: "pptx",
    category: "decks",
    description: "Weekly or monthly status: highlights, risks, milestones, next steps.",
    fields: [
      { key: "project", label: "Project", placeholder: "ERP migration" },
      { key: "highlights", label: "Highlights (one per line)", placeholder: "Phase 2 complete\nUAT started", multiline: true },
      { key: "risks", label: "Risks (one per line)", placeholder: "Data mapping slipped 1 week", multiline: true },
      { key: "next", label: "Next steps (one per line)", placeholder: "Cutover rehearsal\nTraining rollout", multiline: true },
    ],
    generate: async (i, t) =>
      buildOffice(
        {
          kind: "pptx",
          filename: `${i.project || "project"}-status.pptx`,
          slides: [
            { title: `${i.project || "Project"} — status` },
            { title: "Highlights", bullets: lines(i.highlights) },
            { title: "Risks & mitigations", bullets: lines(i.risks) },
            { title: "Next steps", bullets: lines(i.next) },
          ],
        },
        t,
      ),
  },
  {
    id: "memo",
    name: "Business memo",
    kind: "docx",
    category: "documents",
    description: "Decision memo with context, options, recommendation and next steps.",
    fields: [
      { key: "subject", label: "Subject", placeholder: "Vendor consolidation" },
      { key: "context", label: "Context", placeholder: "We currently buy from 14 vendors...", multiline: true },
      { key: "options", label: "Options (one per line)", placeholder: "Consolidate to 3\nKeep as is", multiline: true },
      { key: "recommendation", label: "Recommendation", placeholder: "Consolidate to three primary vendors", multiline: true },
    ],
    generate: async (i, t) =>
      buildOffice(
        {
          kind: "docx",
          filename: `${i.subject || "memo"}.docx`,
          blocks: [
            { heading: i.subject || "Memo", level: 1 },
            { heading: "Context", level: 2 },
            { text: i.context },
            { heading: "Options", level: 2 },
            { bullets: lines(i.options) },
            { heading: "Recommendation", level: 2 },
            { text: i.recommendation },
          ],
        },
        t,
      ),
  },
  {
    id: "one-pager",
    name: "Sales one-pager",
    kind: "docx",
    category: "documents",
    description: "A single page: what you sell, who it is for, proof points, call to action.",
    fields: [
      { key: "product", label: "Product", placeholder: "Northwind Analytics" },
      { key: "value", label: "Value proposition", placeholder: "Cut reporting time by 80%", multiline: true },
      { key: "proof", label: "Proof points (one per line)", placeholder: "120 enterprise customers\nSOC 2 Type II", multiline: true },
    ],
    generate: async (i, t) =>
      buildOffice(
        {
          kind: "docx",
          filename: `${i.product || "one-pager"}.docx`,
          blocks: [
            { heading: i.product || "One-pager", level: 1 },
            { text: i.value },
            { heading: "Why teams choose us", level: 2 },
            { bullets: lines(i.proof) },
          ],
        },
        t,
      ),
  },
  {
    id: "budget",
    name: "Budget vs actual",
    kind: "xlsx",
    category: "workbooks",
    description: "Line-item budget, actuals, variance and % variance, formatted with the brand header.",
    fields: [
      { key: "title", label: "Title", placeholder: "Q1 FY27 budget" },
      {
        key: "rows",
        label: "Rows (Category, Budget, Actual — one per line)",
        placeholder: "Marketing, 120000, 118400\nEngineering, 480000, 502300",
        multiline: true,
      },
    ],
    generate: async (i, t) => {
      const rows: (string | number)[][] = [["Category", "Budget", "Actual", "Variance", "Variance %"]];
      for (const line of lines(i.rows)) {
        const [cat, b, a] = line.split(",").map((s) => s.trim());
        const budget = Number(b) || 0;
        const actual = Number(a) || 0;
        rows.push([
          cat ?? "",
          budget,
          actual,
          actual - budget,
          budget ? Math.round(((actual - budget) / budget) * 1000) / 10 : 0,
        ]);
      }
      return buildOffice({ kind: "xlsx", filename: `${i.title || "budget"}.xlsx`, title: i.title, rows }, t);
    },
  },
  {
    id: "rfp-response",
    name: "RFP response outline",
    kind: "docx",
    category: "documents",
    description: "Executive summary, technical approach, past performance, staffing, compliance — the federal skeleton.",
    fields: [
      { key: "opportunity", label: "Opportunity", placeholder: "DoD Logistics Modernization BPA" },
      { key: "summary", label: "Executive summary", placeholder: "Northwind will modernize...", multiline: true },
      { key: "approach", label: "Approach (one per line)", placeholder: "Discovery sprint\nPhased rollout", multiline: true },
      { key: "past", label: "Past performance (one per line)", placeholder: "USDA Data Platform, 2024", multiline: true },
    ],
    generate: async (i, t) =>
      buildOffice(
        {
          kind: "docx",
          filename: `${i.opportunity || "rfp"}-response.docx`,
          blocks: [
            { heading: i.opportunity || "RFP response", level: 1 },
            { heading: "Executive summary", level: 2 },
            { text: i.summary },
            { heading: "Technical approach", level: 2 },
            { bullets: lines(i.approach) },
            { heading: "Past performance", level: 2 },
            { bullets: lines(i.past) },
          ],
        },
        t,
      ),
  },
];

export async function generateFromTemplate(
  templateId: string,
  kitId: string | null,
  input: StudioInput,
): Promise<
  | { ok: true; filename: string; bytes: number; fileDataUrl: string; template: string }
  | { ok: false; error: string }
> {
  const tpl = builtinTemplates.find((t) => t.id === templateId);
  const theme = themeFromKit(kitId ? getKit(kitId) : null);
  if (tpl) {
    const r = await tpl.generate(input, theme);
    return r.ok ? { ...r, template: tpl.name } : r;
  }
  // Cloned/custom templates regenerate the closest builtin shape using the
  // cloned theme carried in the definition.
  const { listTemplates } = await import("@/lib/brand");
  const row = listTemplates().find((t) => t.id === templateId);
  if (!row) return { ok: false, error: "template not found" };
  const def = row.definition as { colors?: Record<string, string>; fonts?: { heading?: string; body?: string }; orgName?: string };
  const themed: BrandTheme = {
    accent: (def.colors?.accent ?? theme.accent).replace(/^#/, ""),
    heading: def.fonts?.heading ?? theme.heading,
    body: def.fonts?.body ?? theme.body,
    ink: theme.ink,
    orgName: def.orgName ?? theme.orgName,
  };
  const kind = row.kind;
  const title = input.subject || input.title || input.company || row.name;
  const bullets = lines(input.highlights || input.bullets || input.summary || "");
  const r =
    kind === "pptx"
      ? await buildOffice({ kind: "pptx", filename: `${title}.pptx`, slides: [{ title, bullets }] }, themed)
      : kind === "docx"
        ? await buildOffice(
            { kind: "docx", filename: `${title}.docx`, blocks: [{ heading: title, level: 1 }, { text: input.summary || input.body || "" }, { bullets: bullets.slice(0, 8) }] },
            themed,
          )
        : await buildOffice(
            { kind: "xlsx", filename: `${title}.xlsx`, title, rows: [["Item", "Value"], ...bullets.map((b) => b.split(","))] },
            themed,
          );
  return r.ok ? { ...r, template: row.name } : r;
}
