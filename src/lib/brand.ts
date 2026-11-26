// Brand hub: kits, assets and template cloning.
//
// Kits hold the palette, type pairing, written guidelines and voice so every
// generated document, deck and workbook references one source of truth.
// Cloning unzips an uploaded .pptx/.docx/.xlsx and reads its theme part
// (OOXML theme1.xml) for the palette, fonts and slide size.

import { randomUUID } from "node:crypto";
import { getDb } from "@/lib/db";
import JSZip from "jszip";

export type BrandKit = {
  id: string;
  name: string;
  colors: { accent?: string; text?: string; background?: string; muted?: string };
  fonts: { heading?: string; body?: string };
  guidelines: string;
  voice: string;
  updatedAt: string;
};

export type BrandAsset = {
  id: string;
  kitId: string;
  name: string;
  kind: string;
  mime: string;
  data: string; // base64
};

export type ClonedTemplate = {
  kind: "pptx" | "docx" | "xlsx";
  name: string;
  colors: Record<string, string>;
  fonts: { heading?: string; body?: string };
  slideSize?: { width: number; height: number };
  parts: string[]; // theme parts found, for transparency in the UI
};

function rowToKit(r: Record<string, unknown>): BrandKit {
  return {
    id: String(r.id),
    name: String(r.name),
    colors: JSON.parse(String(r.colors || "{}")),
    fonts: JSON.parse(String(r.fonts || "{}")),
    guidelines: String(r.guidelines ?? ""),
    voice: String(r.voice ?? ""),
    updatedAt: String(r.updated_at),
  };
}

export function listKits(): BrandKit[] {
  return (getDb().prepare("SELECT * FROM brand_kits ORDER BY updated_at DESC").all() as Record<string, unknown>[]).map(
    rowToKit,
  );
}

export function getKit(id: string): BrandKit | null {
  const r = getDb().prepare("SELECT * FROM brand_kits WHERE id = ?").get(id) as Record<string, unknown> | undefined;
  return r ? rowToKit(r) : null;
}

export function upsertKit(input: {
  id?: string;
  name: string;
  colors?: BrandKit["colors"];
  fonts?: BrandKit["fonts"];
  guidelines?: string;
  voice?: string;
}): BrandKit {
  const db = getDb();
  const id = input.id ?? randomUUID();
  const existing = getKit(id);
  if (existing || input.id) {
    if (!existing) throw new Error("kit not found");
    db.prepare(
      `UPDATE brand_kits SET name = ?, colors = ?, fonts = ?, guidelines = ?, voice = ?,
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`,
    ).run(
      input.name,
      JSON.stringify({ ...existing.colors, ...input.colors }),
      JSON.stringify({ ...existing.fonts, ...input.fonts }),
      input.guidelines ?? existing.guidelines,
      input.voice ?? existing.voice,
      id,
    );
  } else {
    db.prepare(
      `INSERT INTO brand_kits (id, name, colors, fonts, guidelines, voice) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      input.name,
      JSON.stringify(input.colors ?? {}),
      JSON.stringify(input.fonts ?? {}),
      input.guidelines ?? "",
      input.voice ?? "",
    );
  }
  return getKit(id)!;
}

export function deleteKit(id: string): boolean {
  return getDb().prepare("DELETE FROM brand_kits WHERE id = ?").run(id).changes > 0;
}

export function addAsset(kitId: string, name: string, kind: string, mime: string, base64: string): BrandAsset {
  const asset: BrandAsset = { id: randomUUID(), kitId, name, kind, mime, data: base64 };
  getDb()
    .prepare("INSERT INTO brand_assets (id, kit_id, name, kind, mime, data) VALUES (?, ?, ?, ?, ?, ?)")
    .run(asset.id, asset.kitId, asset.name, asset.kind, asset.mime, asset.data);
  return asset;
}

export function listAssets(kitId: string): Omit<BrandAsset, "data">[] {
  return (
    getDb()
      .prepare("SELECT id, kit_id, name, kind, mime FROM brand_assets WHERE kit_id = ? ORDER BY created_at")
      .all(kitId) as Record<string, unknown>[]
  ).map((r) => ({
    id: String(r.id),
    kitId: String(r.kit_id),
    name: String(r.name),
    kind: String(r.kind),
    mime: String(r.mime),
  }));
}

export function deleteAsset(id: string): boolean {
  return getDb().prepare("DELETE FROM brand_assets WHERE id = ?").run(id).changes > 0;
}

// ---------------------------------------------------------------------------
// Template cloning
// ---------------------------------------------------------------------------

async function firstMsTheme(zip: JSZip): Promise<string | null> {
  const candidates = [
    "ppt/theme/theme1.xml",
    "xl/theme/theme1.xml",
    "word/theme/theme1.xml",
  ];
  let themeXml: string | null = null;
  for (const c of candidates) {
    const f = zip.file(c);
    if (f) themeXml = await f.async("string");
  }
  return themeXml;
}

function text(xml: string, tag: string): string | undefined {
  const m = xml.match(new RegExp(`<${tag}[^>]*val="([^"]+)"`, "i"));
  return m?.[1];
}

export async function cloneTemplate(
  filename: string,
  bytes: Uint8Array,
): Promise<ClonedTemplate> {
  const ext = filename.toLowerCase().match(/\.(pptx|docx|xlsx)$/)?.[1] as ClonedTemplate["kind"] | undefined;
  if (!ext) throw new Error("only .pptx, .docx and .xlsx files can be cloned");
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(bytes);
  } catch {
    throw new Error("not a valid Office file (could not unzip)");
  }
  const themeXml = await firstMsTheme(zip);
  if (!themeXml) throw new Error("no theme part found in the file");

  const schemeOrder = [
    "dk1",
    "lt1",
    "dk2",
    "lt2",
    "accent1",
    "accent2",
    "accent3",
    "accent4",
    "accent5",
    "accent6",
  ];
  const colors: Record<string, string> = {};
  for (const key of schemeOrder) {
    const m = themeXml.match(new RegExp(`<a:${key}>[\\s\\S]*?<a:(?:srgbClr val|sysClr val)="([0-9A-Fa-f]{6})"`, "i"));
    if (m) colors[key] = `#${m[1]}`;
  }
  const accent = colors.accent1 ?? colors.dk2 ?? Object.values(colors)[0];

  const fonts: { heading?: string; body?: string } = {};
  const face = (section: string) =>
    themeXml
      .match(new RegExp(`<a:${section}>[\\s\\S]*?<a:latin\\s+typeface="([^"]*)"`, "i"))?.[1]
      ?.replace(/^[+]/, "");
  const h = face("majorFont");
  const b = face("minorFont");
  if (h && !h.startsWith("+")) fonts.heading = h;
  if (b && !b.startsWith("+")) fonts.body = b;

  let slideSize: { width: number; height: number } | undefined;
  const presXml = zip.file("ppt/presentation.xml");
  if (presXml) {
    const m = (await presXml.async("string")).match(/<p:sldSz\s+cx="(\d+)"\s+cy="(\d+)"/);
    if (m) slideSize = { width: Math.round(Number(m[1]) / 914400 * 100) / 100, height: Math.round(Number(m[2]) / 914400 * 100) / 100 };
  }

  return {
    kind: ext,
    name: filename.replace(/\.[^.]+$/, ""),
    colors: { accent, ...colors },
    fonts,
    slideSize,
    parts: Object.keys(zip.files).filter((p) => /theme|master|styles/.test(p)).slice(0, 12),
  };
}

// Persist a cloned theme as a doc_template whose definition carries the theme,
// and optionally fold its palette into a kit.
export function saveClonedTemplate(input: {
  kitId?: string;
  name: string;
  kind: ClonedTemplate["kind"];
  definition: Record<string, unknown>;
}): string {
  const id = randomUUID();
  getDb()
    .prepare("INSERT INTO doc_templates (id, kit_id, name, kind, source, definition) VALUES (?, ?, ?, ?, 'cloned', ?)")
    .run(id, input.kitId ?? null, input.name, input.kind, JSON.stringify(input.definition));
  return id;
}

export type DocTemplateRow = {
  id: string;
  kitId: string | null;
  name: string;
  kind: "pptx" | "docx" | "xlsx";
  source: "builtin" | "cloned" | "custom";
  definition: Record<string, unknown>;
  createdAt: string;
};

export function listTemplates(): DocTemplateRow[] {
  return (
    getDb().prepare("SELECT * FROM doc_templates ORDER BY created_at DESC").all() as Record<string, unknown>[]
  ).map((r) => ({
    id: String(r.id),
    kitId: (r.kit_id as string | null) ?? null,
    name: String(r.name),
    kind: r.kind as DocTemplateRow["kind"],
    source: r.source as DocTemplateRow["source"],
    definition: JSON.parse(String(r.definition || "{}")),
    createdAt: String(r.created_at),
  }));
}

export function deleteTemplate(id: string): boolean {
  return getDb().prepare("DELETE FROM doc_templates WHERE id = ?").run(id).changes > 0;
}
