// Attachment storage: upload once, reference by id from message parts.
// Clients never get to hand the model arbitrary bytes for older turns; the chat
// route resolves the latest turn's files from here (see lib/attachments.ts).
import { guard } from "@/lib/guard";
import {
  MAX_FILE_BYTES,
  isAllowedMediaType,
  readUpload,
  saveUpload,
} from "@/lib/attachments";
import { isActiveMediaType } from "@/lib/sanitize";

export async function POST(req: Request) {
  const gate = await guard(req);
  if (gate instanceof Response) return gate;

  const contentType = req.headers.get("content-type") ?? "";
  let filename = "";
  let mediaType = "";
  let bytes: Uint8Array;

  try {
    if (contentType.includes("multipart/form-data")) {
      const form = await req.formData();
      const file = form.get("file");
      if (!(file instanceof File)) {
        return Response.json({ error: { message: "Send the file as form field 'file'." } }, { status: 400 });
      }
      filename = file.name;
      mediaType = file.type || "application/octet-stream";
      bytes = new Uint8Array(await file.arrayBuffer());
    } else {
      const body = (await req.json()) as { filename?: string; mediaType?: string; dataBase64?: string };
      if (typeof body.dataBase64 !== "string" || !body.dataBase64) {
        return Response.json({ error: { message: "Send multipart form data or {dataBase64, mediaType, filename}." } }, { status: 400 });
      }
      filename = body.filename ?? "file";
      mediaType = body.mediaType ?? "application/octet-stream";
      bytes = new Uint8Array(Buffer.from(body.dataBase64, "base64"));
    }
  } catch {
    return Response.json({ error: { message: "Request body could not be read." } }, { status: 400 });
  }

  if (bytes.byteLength > MAX_FILE_BYTES) {
    return Response.json(
      { error: { message: `Files are limited to ${MAX_FILE_BYTES / (1024 * 1024)} MB.` } },
      { status: 413 },
    );
  }
  if (!isAllowedMediaType(mediaType)) {
    return Response.json({ error: { message: `Unsupported file type: ${mediaType}.` } }, { status: 415 });
  }

  try {
    const saved = await saveUpload({ filename, mediaType, data: bytes });
    return Response.json({ file: saved, url: `/api/files/${saved.id}` });
  } catch (error) {
    return Response.json(
      { error: { message: error instanceof Error ? error.message : "Upload failed." } },
      { status: 400 },
    );
  }
}

export async function GET(req: Request) {
  const gate = await guard(req);
  if (gate instanceof Response) return gate;

  const id = new URL(req.url).searchParams.get("id") ?? "";
  const stored = await readUpload(id);
  if (!stored) return Response.json({ error: { message: "File not found." } }, { status: 404 });

  // Any file that would execute on the app's own origin (HTML, SVG, XML, PDF
  // with embedded script) is never rendered inline: it is served as a download
  // and, if a browser still renders it, inside an opaque sandbox with no
  // scripts, no same-origin access and no network.
  const active = isActiveMediaType(stored.meta.mediaType);
  const filename = stored.meta.filename.replace(/[^\w.\- ]+/g, "_").slice(0, 120) || "file";
  const headers: Record<string, string> = {
    "content-type": stored.meta.mediaType,
    "content-length": String(stored.meta.bytes),
    "content-disposition": `${active ? "attachment" : "inline"}; filename="${filename}"`,
    "cache-control": "private, max-age=3600",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
  };
  if (active) {
    headers["content-security-policy"] = "sandbox; default-src 'none'; script-src 'none'; object-src 'none'";
    headers["cross-origin-resource-policy"] = "same-origin";
  }

  return new Response(new Uint8Array(stored.data), { headers });
}
