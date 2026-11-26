// Branded Office document generation.
//
// Every snippet runs inside the code sandbox (see runCode with captureFiles),
// where exceljs / docx / pptxgenjs resolve through NODE_PATH. A BrandTheme
// carries the kit's palette and type into every generated file so documents
// come out on-brand without the model ever hand-writing styles.

import { runCode } from "@/lib/sandbox";

export type BrandTheme = {
  accent: string; // hex without '#', e.g. "0F6B5C"
  heading: string; // display face for titles
  body: string; // text face
  ink: string; // near-black for body text
  orgName: string; // footer / masthead text
};

export const defaultTheme: BrandTheme = {
  accent: "0F6B5C",
  heading: "Inter",
  body: "Inter",
  ink: "1F2937",
  orgName: "",
};

export function themeFromKit(kit?: {
  colors?: unknown;
  fonts?: unknown;
  name?: string;
} | null): BrandTheme {
  const colors = (kit?.colors ?? {}) as Record<string, string>;
  const fonts = (kit?.fonts ?? {}) as Record<string, string>;
  const strip = (c?: string) => (c ?? "").replace(/^#/, "").replace(/[^0-9a-fA-F]/g, "").slice(0, 6);
  return {
    accent: strip(colors.accent) || defaultTheme.accent,
    heading: fonts.heading || defaultTheme.heading,
    body: fonts.body || defaultTheme.body,
    ink: strip(colors.text) || defaultTheme.ink,
    orgName: kit?.name ?? defaultTheme.orgName,
  };
}

type OfficeRequest = {
  kind: "xlsx" | "docx" | "pptx";
  filename: string;
  title?: string;
  rows?: (string | number)[][];
  blocks?: { heading?: string; level?: number; text?: string; bullets?: string[] }[];
  slides?: { title: string; bullets?: string[]; notes?: string }[];
};

function esc(s: string): string {
  return JSON.stringify(s);
}

export async function buildOffice(
  req: OfficeRequest,
  theme: BrandTheme = defaultTheme,
): Promise<{ ok: true; filename: string; bytes: number; fileDataUrl: string } | { ok: false; error: string }> {
  const ext = req.kind;
  const safe =
    (req.filename.replace(/\.(xlsx|docx|pptx)$/i, "").replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 100) || "document") +
    "." + ext;
  const code = officeSnippet(req, theme) + `
const fs = require("fs");
async function __q() { return fs.promises.copyFile(${esc(`out.${ext}`)}, ${esc(safe)}); }
(async () => {
  const poll = (ms) => new Promise((r) => setTimeout(r, ms));
  for (let i = 0; i < 100; i++) {
    try { await __q(); console.log("written"); return; }
    catch (e) { if (e.code !== "ENOENT") throw e; await poll(100); }
  }
  throw new Error("document was never written");
})();
`;
  const r = await runCode({ language: "javascript", code, captureFiles: true });
  const f = r.capturedFiles?.find((x) => x.name === safe) ?? r.capturedFiles?.[0];
  if (!f) return { ok: false, error: r.stderr || "no file was produced" };
  return {
    ok: true,
    filename: f.name,
    bytes: f.bytes,
    fileDataUrl: `data:application/octet-stream;base64,${f.base64}`,
  };
}

export function officeSnippet(
  req: OfficeRequest,
  theme: BrandTheme,
): string {
  const t = {
    accent: esc(theme.accent),
    heading: esc(theme.heading),
    body: esc(theme.body),
    ink: esc(theme.ink),
    org: esc(theme.orgName),
  };
  if (req.kind === "xlsx") {
    return `
const ExcelJS = require("exceljs");
const wb = new ExcelJS.Workbook();
${req.title ? `wb.properties.title = ${esc(req.title)};` : ""}
const ws = wb.addWorksheet(${esc(req.title ?? "Sheet1")});
const rows = ${JSON.stringify(req.rows ?? [])};
if (rows.length) {
  const head = ws.addRow(rows[0]);
  head.font = { bold: true, color: { argb: "FF" + ${t.accent}.toUpperCase() }, name: ${t.heading}, size: 12 };
  head.eachCell((c) => { c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF" + ${t.accent}.toUpperCase() + "" } }; c.font = { bold: true, color: { argb: "FFFFFFFF" }, name: ${t.body} }; });
  for (const row of rows.slice(1)) ws.addRow(row).font = { name: ${t.body}, color: { argb: "FF" + ${t.ink}.toUpperCase() } };
  ws.columns.forEach((c) => { if (c) c.width = 22; });
  ws.views = [{ state: "frozen", ySplit: 1 }];
}
${theme.orgName ? `ws.headerFooter.oddHeader = ${esc(theme.orgName)};` : ""}
wb.xlsx.writeFile(${esc("out.xlsx")}).then(() => console.log("done"));
`;
  }
  if (req.kind === "docx") {
    return `
const { Document, Packer, Paragraph, HeadingLevel, TextRun } = require("docx");
const blocks = ${JSON.stringify(req.blocks ?? [])};
const children = [];
for (const b of blocks) {
  if (b.heading) children.push(new Paragraph({ text: b.heading, heading: [HeadingLevel.HEADING_1, HeadingLevel.HEADING_2, HeadingLevel.HEADING_3][(b.level || 1) - 1] }));
  if (b.text) children.push(new Paragraph({ children: [new TextRun({ text: b.text, font: ${t.body}, color: ${t.ink} })], spacing: { after: 160, line: 300 } }));
  if (b.bullets) for (const item of b.bullets) children.push(new Paragraph({ text: item, bullet: { level: 0 }, spacing: { after: 80 } }));
}
const doc = new Document({
  styles: {
    default: { document: { run: { font: ${t.body}, color: ${t.ink} } } },
    paragraphStyles: [
      { id: "Heading1", name: "Heading 1", basedOn: "Normal", next: "Normal", quickFormat: true,
        run: { font: ${t.heading}, color: ${t.accent}, size: 40, bold: true },
        paragraph: { spacing: { before: 240, after: 120 } } },
      { id: "Heading2", name: "Heading 2", basedOn: "Normal", next: "Normal", quickFormat: true,
        run: { font: ${t.heading}, color: ${t.accent}, size: 30, bold: true },
        paragraph: { spacing: { before: 200, after: 100 } } },
      { id: "Heading3", name: "Heading 3", basedOn: "Normal", next: "Normal", quickFormat: true,
        run: { font: ${t.heading}, color: ${t.ink}, size: 24, bold: true } },
    ],
  },
  sections: [{ children }],
});
Packer.toBuffer(doc).then((buf) => require("fs").writeFileSync(${esc("out.docx")}, buf));
`;
  }
  return `
const PptxGenJS = require("pptxgenjs");
const pres = new PptxGenJS();
pres.defineLayout({ name: "W", width: 10, height: 5.63 });
pres.layout = "W";
pres.theme = { headFontFace: ${t.heading}, bodyFontFace: ${t.body} };
const slides = ${JSON.stringify(req.slides ?? [])};
const org = ${t.org};
for (const s of slides) {
  const slide = pres.addSlide();
  slide.addShape(pres.ShapeType.rect, { x: 0, y: 0, w: 0.12, h: 5.63, fill: { color: ${t.accent} } });
  slide.addText(s.title, { x: 0.6, y: 0.4, w: 8.8, fontSize: 28, bold: true, color: ${t.accent}, fontFace: ${t.heading} });
  if (s.bullets && s.bullets.length) slide.addText(s.bullets.map((tx) => ({ text: tx, options: { bullet: { code: "2022" }, breakLine: true } })), { x: 0.9, y: 1.4, w: 8.2, fontSize: 16, color: ${t.ink}, fontFace: ${t.body}, lineSpacing: 26 });
  if (s.notes) slide.addNotes(s.notes);
  if (org) slide.addText(org, { x: 0.6, y: 5.2, w: 8.8, fontSize: 9, color: "9CA3AF", fontFace: ${t.body} });
}
pres.writeFile({ fileName: ${esc("out.pptx")} });
`;
}
