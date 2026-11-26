async function secure(req: Request) {
  const gate = await guard(req);
  if (gate instanceof Response) return gate;
  return gate;
}

import { NextResponse } from "next/server";
import { addAsset, deleteKit, deleteAsset, listAssets, listKits, upsertKit, cloneTemplate, saveClonedTemplate } from "@/lib/brand";

import { guard } from "@/lib/guard";
export const dynamic = "force-dynamic";

export async function GET() {
  const kits = listKits().map((k) => ({ ...k, assets: listAssets(k.id) }));
  return NextResponse.json({ kits });
}

export async function POST(request: Request) {
  const denied = await secure(request);
  if (denied instanceof Response) return denied;

  const ct = request.headers.get("content-type") ?? "";
  // Template cloning: multipart upload of a .pptx/.docx/.xlsx.
  if (ct.includes("multipart/form-data")) {
    const form = await request.formData();
    const file = form.get("file");
    if (!(file instanceof File)) return NextResponse.json({ error: "file is required" }, { status: 400 });
    const bytes = new Uint8Array(await file.arrayBuffer());
    try {
      const cloned = await cloneTemplate(file.name, bytes);
      const kitId = form.get("kitId");
      const id = saveClonedTemplate({
        kitId: typeof kitId === "string" && kitId ? kitId : undefined,
        name: cloned.name,
        kind: cloned.kind,
        definition: { colors: cloned.colors, fonts: cloned.fonts, slideSize: cloned.slideSize, parts: cloned.parts },
      });
      return NextResponse.json({ templateId: id, cloned });
    } catch (err) {
      return NextResponse.json({ error: err instanceof Error ? err.message : "clone failed" }, { status: 400 });
    }
  }
  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  if (!body || typeof body.name !== "string" || !body.name.trim()) {
    return NextResponse.json({ error: "name is required" }, { status: 400 });
  }
  const kit = upsertKit({
    id: typeof body.id === "string" ? body.id : undefined,
    name: body.name,
    colors: body.colors as never,
    fonts: body.fonts as never,
    guidelines: typeof body.guidelines === "string" ? body.guidelines : undefined,
    voice: typeof body.voice === "string" ? body.voice : undefined,
  });
  return NextResponse.json({ kit });
}

export async function PUT(request: Request) {
  const denied = await secure(request);
  if (denied instanceof Response) return denied;

  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  if (!body || typeof body.id !== "string") return NextResponse.json({ error: "id is required" }, { status: 400 });
  if (typeof body.assetName === "string" && typeof body.assetData === "string") {
    const asset = addAsset(body.id, body.assetName, String(body.assetKind ?? "logo"), String(body.assetMime ?? "image/png"), body.assetData);
    return NextResponse.json({ asset: { id: asset.id, name: asset.name, kind: asset.kind, mime: asset.mime } });
  }
  const kit = upsertKit({
    id: body.id,
    name: typeof body.name === "string" ? body.name : "",
    colors: body.colors as never,
    fonts: body.fonts as never,
    guidelines: typeof body.guidelines === "string" ? body.guidelines : undefined,
    voice: typeof body.voice === "string" ? body.voice : undefined,
  });
  return NextResponse.json({ kit });
}

export async function DELETE(request: Request) {
  const denied = await secure(request);
  if (denied instanceof Response) return denied;

  const url = new URL(request.url);
  const kitId = url.searchParams.get("kitId");
  const assetId = url.searchParams.get("assetId");
  if (assetId) return NextResponse.json({ ok: deleteAsset(assetId) });
  if (!kitId) return NextResponse.json({ error: "kitId or assetId is required" }, { status: 400 });
  return NextResponse.json({ ok: deleteKit(kitId) });
}
