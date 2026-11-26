async function secure(req: Request) {
  const gate = await guard(req);
  if (gate instanceof Response) return gate;
  return gate;
}

import { NextResponse } from "next/server";
import { builtinTemplates, generateFromTemplate } from "@/lib/studio";
import { listTemplates, deleteTemplate } from "@/lib/brand";

import { guard } from "@/lib/guard";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function GET() {
  return NextResponse.json({
    builtin: builtinTemplates.map(({ id, name, kind, category, description, fields }) => ({
      id, name, kind, category, description, fields,
    })),
    cloned: listTemplates(),
  });
}

export async function POST(request: Request) {
  const denied = await secure(request);
  if (denied instanceof Response) return denied;

  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  if (!body || typeof body.templateId !== "string") {
    return NextResponse.json({ error: "templateId is required" }, { status: 400 });
  }
  const result = await generateFromTemplate(
    body.templateId,
    typeof body.kitId === "string" && body.kitId ? body.kitId : null,
    (body.input ?? {}) as Record<string, string>,
  );
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 400 });
  return NextResponse.json(result);
}

export async function DELETE(request: Request) {
  const denied = await secure(request);
  if (denied instanceof Response) return denied;

  const id = new URL(request.url).searchParams.get("templateId");
  if (!id) return NextResponse.json({ error: "templateId is required" }, { status: 400 });
  return NextResponse.json({ ok: deleteTemplate(id) });
}
