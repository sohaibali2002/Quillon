// Verification API: run the document verification engine over structured
// summaries (parsed client- or sandbox-side) and list past reports.
import { z } from "zod";
import { guard, audit } from "@/lib/guard";
import { principalForSession } from "@/lib/rbac";
import {
  verifySpreadsheet, verifyFormulaConsistency, verifyDeck, verifyDocument, saveReport, listReports,
} from "@/lib/verify";

export const maxDuration = 30;

const sheetSchema = z.object({
  name: z.string(),
  formulas: z.array(z.string()),
  literals: z.array(z.string()),
  brokenRefs: z.array(z.string()).default([]),
});

const schema = z.discriminatedUnion("target", [
  z.object({
    target: z.literal("xlsx"),
    name: z.string().min(1),
    sheets: z.array(sheetSchema).min(1),
    formulaColumns: z.record(z.string(), z.array(z.object({ ref: z.string(), body: z.string() }))).optional(),
  }),
  z.object({
    target: z.literal("pptx"),
    name: z.string().min(1),
    slides: z.array(z.object({
      index: z.number().int().min(1),
      fonts: z.array(z.string()).default([]),
      overflow: z.boolean().default(false),
      titles: z.array(z.string()).default([]),
    })).min(1),
  }),
  z.object({
    target: z.literal("docx"),
    name: z.string().min(1),
    headings: z.array(z.string()).default([]),
    words: z.number().int().min(0).default(0),
    citationCount: z.number().int().min(0).default(0),
    dates: z.array(z.string()).default([]),
  }),
]);

export async function GET(req: Request) {
  const gate = await guard(req);
  if (gate instanceof Response) return gate;
  return Response.json({ reports: listReports(25, principalForSession(gate).tenant) });
}

export async function POST(req: Request) {
  const gate = await guard(req, { role: "member" });
  if (gate instanceof Response) return gate;
  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return Response.json({ error: { message: "Invalid verification request." } }, { status: 400 });
  }
  const body = parsed.data;
  let checks;
  if (body.target === "xlsx") {
    checks = verifySpreadsheet(body.sheets);
    if (body.formulaColumns) {
      checks.push(...verifyFormulaConsistency(body.formulaColumns));
    }
  } else if (body.target === "pptx") {
    checks = verifyDeck({ slides: body.slides });
  } else {
    checks = verifyDocument(body);
  }
  const report = saveReport(body.target, body.name, checks, principalForSession(gate).tenant);
  audit(req, gate, "verify.report", report.id, { target: body.target, name: body.name, verdict: report.verdict });
  return Response.json({ report });
}
