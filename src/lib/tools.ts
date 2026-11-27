// Shared tools used by the chat route and the agent route.
import { tool } from "ai";
import { z } from "zod";
import { runCode } from "@/lib/sandbox";
import { searchConnectorTool } from "@/lib/connector-tools";

export const runCodeTool = tool({
  description:
    "Execute code in a sandboxed temp directory. Languages: " +
    "javascript, typescript, python, bash, ruby, php (or pass a custom " +
    '"command" argv array for any other interpreter). Optional "files" are ' +
    'written next to the entry file so the code can read them (e.g. ' +
    'open("data.csv")). Output arrives as stdout/stderr/exitCode.',
  inputSchema: z.object({
    language: z
      .string()
      .describe("Language id: javascript, typescript, python, bash, ruby, php, …"),
    code: z.string().describe("Source code to execute"),
    files: z
      .array(z.object({ name: z.string(), content: z.string() }))
      .optional()
      .describe("Data files written next to the entry file, readable by name"),
    stdin: z.string().optional().describe("Optional text piped to the process stdin"),
  }),
  execute: async ({ language, code, files, stdin }) => {
    const r = await runCode({ language, code, files, stdin });
    return {
      language: r.language,
      stdout: r.stdout,
      stderr: r.stderr,
      exitCode: r.exitCode,
      error: r.error,
      durationMs: r.durationMs,
      filesWritten: r.filesWritten,
    };
  },
});

export const makeDocumentTool = tool({
  description:
    "Generate a real Office document and return it as a downloadable file. " +
    "kinds: 'xlsx' (spreadsheet from rows), 'docx' (Word document from " +
    "paragraphs/headings), 'pptx' (PowerPoint from slide titles+bullets). " +
    "The file data URL is returned in output.fileDataUrl — surface it as a " +
    "download link.",
  inputSchema: z.object({
    kind: z.enum(["xlsx", "docx", "pptx"]).describe("Document type to build"),
    filename: z.string().describe("Output file name ending in .xlsx, .docx or .pptx"),
    title: z.string().optional().describe("Document title / workbook name"),
    // xlsx: first row is headers.
    rows: z
      .array(z.array(z.union([z.string(), z.number()])))
      .optional()
      .describe("xlsx only: rows of cells, first row headers"),
    // docx: heading levels 1-3 start a section, plain strings are paragraphs.
    blocks: z
      .array(
        z.object({
          heading: z.string().optional(),
          level: z.number().int().min(1).max(3).optional(),
          text: z.string().optional(),
          bullets: z.array(z.string()).optional(),
        }),
      )
      .optional()
      .describe("docx only: paragraphs, headings and bullet lists in order"),
    slides: z
      .array(z.object({ title: z.string(), bullets: z.array(z.string()).optional() }))
      .optional()
      .describe("pptx only: one entry per slide"),
  }),
  execute: async ({ kind, filename, title, rows, blocks, slides }) => {
    const { buildOffice, defaultTheme } = await import("@/lib/office");
    return buildOffice({ kind, filename, title, rows, blocks, slides }, defaultTheme);
  },
});

export const platformTools = {
  runCode: runCodeTool,
  makeDocument: makeDocumentTool,
  searchConnector: searchConnectorTool,
};

export const builtinTools = platformTools;

