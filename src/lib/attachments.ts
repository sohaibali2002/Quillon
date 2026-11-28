// Chat attachments: files are uploaded once to /api/files and referenced by id
// in message parts. The model gets actual bytes only for files on the latest
// user turn; earlier turns carry a text placeholder, so a thread with an image
// re-sends megabytes on every message and the token estimate stays honest.
//
// Storage is tenant- and owner-scoped: a row in `uploads` records who can read
// a file, every read path requires that identity, and file bytes live under a
// per-file directory written with O_NOFOLLOW so a planted symlink cannot
// redirect a write or a read outside the store.
import { mkdir, open, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { UIMessage } from "ai";
import { getDb } from "@/lib/db";
import { tenantScope } from "@/lib/tenant-context";

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

// Magic-byte signatures for the binary types on the allowlist. A client-declared
// Content-Type is a claim, not a fact; a file whose leading bytes contradict its
// declared type is rejected rather than stored and later parsed by a converter.
const SIGNATURES: Array<{ type: string; offset: number; bytes: number[] }> = [
  { type: "application/pdf", offset: 0, bytes: [0x25, 0x50, 0x44, 0x46] }, // %PDF
  { type: "image/png", offset: 0, bytes: [0x89, 0x50, 0x4e, 0x47] },
  { type: "image/jpeg", offset: 0, bytes: [0xff, 0xd8, 0xff] },
  { type: "image/gif", offset: 0, bytes: [0x47, 0x49, 0x46, 0x38] }, // GIF8
  { type: "image/webp", offset: 0, bytes: [0x52, 0x49, 0x46, 0x46] }, // RIFF
  {
    type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    offset: 0,
    bytes: [0x50, 0x4b, 0x03, 0x04],
  }, // PK\x03\x04 (zip)
  {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    offset: 0,
    bytes: [0x50, 0x4b, 0x03, 0x04],
  },
  {
    type: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    offset: 0,
    bytes: [0x50, 0x4b, 0x03, 0x04],
  },
  { type: "application/msword", offset: 0, bytes: [0xd0, 0xcf, 0x11, 0xe0] }, // OLE2
];

export function mediaTypeMatchesSignature(mediaType: string, head: Uint8Array): boolean {
  const t = mediaType.toLowerCase().split(";")[0].trim();
  const sig = SIGNATURES.find((s) => s.type === t);
  // Types without a checked signature rule here pass; the allowlist and the
  // downstream parsers bound them. Binary types must match their magic bytes.
  if (!sig) return true;
  if (head.length < sig.bytes.length) return false;
  return sig.bytes.every((b, i) => head[sig.offset + i] === b);
}

export type UploadedFile = { id: string; filename: string; mediaType: string; bytes: number };

async function writeUploadFile(id: string, data: Uint8Array): Promise<void> {
  await mkdir(UPLOAD_DIR, { recursive: true });
  // "wx" fails if the path exists (including as a symlink — it does not follow
  // one), so a pre-planted link can never redirect the write.
  const handle = await open(path.join(UPLOAD_DIR, id), "wx", 0o600);
  try {
    await handle.writeFile(data);
  } finally {
    await handle.close();
  }
}

export async function saveUpload(input: {
  filename: string;
  mediaType: string;
  data: Uint8Array;
  tenant?: string;
  ownerId?: string;
}): Promise<UploadedFile> {
  if (input.data.byteLength === 0) throw new Error("The file is empty.");
  if (input.data.byteLength > MAX_FILE_BYTES) {
    throw new Error(`Files are limited to ${MAX_FILE_BYTES / (1024 * 1024)} MB.`);
  }
  if (!isAllowedMediaType(input.mediaType)) {
    throw new Error(`Unsupported file type: ${input.mediaType}.`);
  }
  if (!mediaTypeMatchesSignature(input.mediaType, input.data.subarray(0, 8))) {
    throw new Error(`File contents do not match the declared type ${input.mediaType}.`);
  }
  const tenant = tenantScope(input.tenant);
  const ownerId = input.ownerId ?? "anonymous";
  await mkdir(UPLOAD_DIR, { recursive: true });
  const id = randomUUID();
  await writeUploadFile(id, input.data);
  const meta: UploadedFile = {
    id,
    filename: path.basename(input.filename || "file"),
    mediaType: input.mediaType,
    bytes: input.data.byteLength,
  };
  await writeFile(path.join(UPLOAD_DIR, `${id}.json`), JSON.stringify({ ...meta, tenant, ownerId }));
  getDb()
    .prepare(
      "INSERT INTO uploads (id, tenant_id, owner_id, filename, media_type, size) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .run(id, tenant, ownerId, meta.filename, meta.mediaType, meta.bytes);
  return meta;
}

/**
 * Read an upload under authorization: the caller must present the same tenant
 * and owner the file was uploaded with. A random UUID is an identifier, never
 * a capability.
 */
export async function readUpload(
  id: string,
  identity?: { tenant?: string; owner?: string },
): Promise<{ meta: UploadedFile; data: Buffer } | null> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  let record: { tenant: string; ownerId: string } | null = null;
  const row = getDb()
    .prepare("SELECT tenant_id, owner_id FROM uploads WHERE id = ?")
    .get(id) as { tenant_id: string; owner_id: string } | undefined;
  if (row) record = { tenant: row.tenant_id, ownerId: row.owner_id };
  if (identity) {
    const tenant = tenantScope(identity.tenant);
    if (!record || record.tenant !== tenant || record.ownerId !== identity.owner) return null;
  }
  try {
    const meta = JSON.parse(await readFile(path.join(UPLOAD_DIR, `${id}.json`), "utf8")) as UploadedFile;
    const data = await readFile(path.join(UPLOAD_DIR, id));
    return { meta, data };
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
// Attachments ride with the conversation, so they resolve under the
// conversation owner's identity — the chat route sets the tenant context.
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
