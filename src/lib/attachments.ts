// Chat attachments: files are uploaded once to /api/files and referenced by id
// in message parts. The model gets actual bytes only for files on the latest
// user turn; earlier turns carry a text placeholder, so a thread with an image
// re-sends megabytes on every message and the token estimate stays honest.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { UIMessage } from "ai";

export const MAX_FILE_BYTES = 20 * 1024 * 1024;
export const MAX_INLINE_DATA_URL_BYTES = 2 * 1024 * 1024;
export const MAX_FILES_PER_TURN = 6;

const UPLOAD_DIR = path.join(process.cwd(), ".data", "uploads");

// A conservative allowlist: text/docs/images the model and the Office tools can
// actually consume. Anything else is refused with a clear message.
const ALLOWED_EXACT = new Set([
  "application/pdf",
  "application/json",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "text/csv",
  "text/markdown",
  "text/plain",
  "text/html",
  "text/xml",
  "application/xml",
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "audio/mpeg",
  "audio/wav",
  "video/mp4",
]);

export function isAllowedMediaType(mediaType: string): boolean {
  const t = mediaType.toLowerCase().split(";")[0].trim();
  return ALLOWED_EXACT.has(t);
}

export type UploadedFile = { id: string; filename: string; mediaType: string; bytes: number };

export async function saveUpload(input: {
  filename: string;
  mediaType: string;
  data: Uint8Array;
}): Promise<UploadedFile> {
  if (input.data.byteLength === 0) throw new Error("The file is empty.");
  if (input.data.byteLength > MAX_FILE_BYTES) {
    throw new Error(`Files are limited to ${MAX_FILE_BYTES / (1024 * 1024)} MB.`);
  }
  if (!isAllowedMediaType(input.mediaType)) {
    throw new Error(`Unsupported file type: ${input.mediaType}.`);
  }
  await mkdir(UPLOAD_DIR, { recursive: true });
  const id = randomUUID();
  await writeFile(path.join(UPLOAD_DIR, id), input.data);
  const meta: UploadedFile = {
    id,
    filename: path.basename(input.filename || "file"),
    mediaType: input.mediaType,
    bytes: input.data.byteLength,
  };
  await writeFile(path.join(UPLOAD_DIR, `${id}.json`), JSON.stringify(meta));
  return meta;
}

export async function readUpload(id: string): Promise<{ meta: UploadedFile; data: Buffer } | null> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  try {
    const meta = JSON.parse(await readFile(path.join(UPLOAD_DIR, `${id}.json`), "utf8")) as UploadedFile;
    return { meta, data: await readFile(path.join(UPLOAD_DIR, id)) };
  } catch {
    return null;
  }
}

export function uploadedFileId(url: string | undefined): string | null {
  if (!url) return null;
  const m = /^\/api\/files\/([0-9a-f-]{36})$/i.exec(url);
  return m ? m[1] : null;
}

type FilePart = { type: "file"; mediaType?: string; filename?: string; url?: string };

function fileSizeOf(part: FilePart): number {
  const url = part.url ?? "";
  const m = /^data:[^;,]*;base64,/.exec(url);
  if (m) return Math.floor(((url.length - m[0].length) * 3) / 4);
  return 0;
}

// Validate every file part of the incoming thread (size + type + reference) and
// return model-ready messages: latest user turn files become data URLs, older
// ones become text placeholders that also feed the compaction summary.
export async function resolveAttachmentsForModel(
  messages: UIMessage[],
): Promise<{ messages: UIMessage[]; notes: string[] }> {
  const lastUser = [...messages].reverse().find((m) => m.role === "user");
  const notes: string[] = [];
  const out: UIMessage[] = [];
  for (const message of messages) {
    const isLatestUser = message === lastUser;
    const parts: unknown[] = [];
    for (const part of message.parts as FilePart[]) {
      if (part.type !== "file") {
        parts.push(part);
        continue;
      }
      const mediaType = part.mediaType ?? "";
      if (!mediaType || !isAllowedMediaType(mediaType)) {
        throw new Error(`Unsupported file type: ${mediaType || "unknown"}.`);
      }
      const id = uploadedFileId(part.url);
      if (isLatestUser) {
        if (id) {
          const stored = await readUpload(id);
          if (!stored) throw new Error(`Attachment "${part.filename ?? id}" was not found; upload it again.`);
          if (stored.meta.bytes > MAX_FILE_BYTES) {
            throw new Error(`Files are limited to ${MAX_FILE_BYTES / (1024 * 1024)} MB.`);
          }
          parts.push({
            ...part,
            mediaType: stored.meta.mediaType,
            filename: stored.meta.filename,
            url: `data:${stored.meta.mediaType};base64,${stored.data.toString("base64")}`,
          });
          continue;
        }
        if (part.url?.startsWith("data:")) {
          if (fileSizeOf(part) > MAX_INLINE_DATA_URL_BYTES) {
            throw new Error(
              `Inline files are limited to ${MAX_INLINE_DATA_URL_BYTES / (1024 * 1024)} MB; upload larger files through /api/files.`,
            );
          }
          parts.push(part);
          continue;
        }
        throw new Error(`Attachment "${part.filename ?? "file"}" has no readable source.`);
      }
      // Older turns: keep the reference for the UI, give the model a note only.
      const note = `[attached file: ${part.filename ?? "file"} (${mediaType})]`;
      notes.push(note);
      parts.push({ type: "text", text: note });
    }
    out.push({ ...message, parts } as UIMessage);
  }
  return { messages: out, notes };
}
