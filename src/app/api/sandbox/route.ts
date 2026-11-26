// Code-execution sandbox route: runs code in any supported language as a
// child process in a temp directory, with optional data-file ingestion.
//   { language, code, files?: [{name, content}], stdin?, timeoutMs?, command?,
//     captureFiles? }
import { z } from "zod";
import {
  MAX_CODE_CHARS,
  MAX_FILE_CHARS,
  MAX_FILES,
  MAX_OUTPUT_CHARS,
  MAX_TIMEOUT_MS,
  listLanguages,
  runCode,
} from "@/lib/sandbox";

export const maxDuration = 30;

// Source of truth for the UI: languages and limits come from the runner itself.
export function GET() {
  return Response.json({
    languages: listLanguages(),
    limits: {
      timeoutMs: MAX_TIMEOUT_MS,
      minTimeoutMs: 100,
      codeChars: MAX_CODE_CHARS,
      fileChars: MAX_FILE_CHARS,
      files: MAX_FILES,
      outputChars: MAX_OUTPUT_CHARS,
    },
  });
}

const fileSchema = z.object({
  name: z.string().min(1).max(200),
  content: z.string().max(MAX_FILE_CHARS),
});

const bodySchema = z.object({
  language: z.string().min(1).max(40).optional(),
  code: z.string().min(1).max(MAX_CODE_CHARS),
  files: z.array(fileSchema).max(MAX_FILES).optional(),
  stdin: z.string().max(MAX_FILE_CHARS).optional(),
  timeoutMs: z.number().int().min(100).max(MAX_TIMEOUT_MS).optional(),
  command: z.array(z.string().min(1).max(500)).min(1).max(16).optional(),
  captureFiles: z.boolean().optional(),
});

export async function POST(req: Request) {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return Response.json(
      { error: { message: "Request body must be valid JSON." } },
      { status: 400 },
    );
  }

  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) {
    return Response.json(
      {
        error: {
          message: "Invalid request body.",
          issues: parsed.error.issues.map((i) => ({
            path: i.path.join("."),
            message: i.message,
          })),
        },
      },
      { status: 400 },
    );
  }

  const result = await runCode({
    language: parsed.data.language ?? "javascript",
    code: parsed.data.code,
    files: parsed.data.files,
    stdin: parsed.data.stdin,
    timeoutMs: parsed.data.timeoutMs,
    command: parsed.data.command,
    captureFiles: parsed.data.captureFiles,
  });
  return Response.json(result);
}
