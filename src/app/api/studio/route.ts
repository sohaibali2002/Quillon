async function secure(req: Request) {
  const gate = await guard(req);
  if (gate instanceof Response) return gate;
  return gate;
}

import { NextResponse } from "next/server";
import { builtinTemplates, generateFromTemplate } from "@/lib/studio";
import { deleteTemplate, listTemplates } from "@/lib/brand";
import { guard } from "@/lib/guard";
import { principalForSession } from "@/lib/rbac";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function GET(req: Request) {
  const gate = await guard(req);
  if (gate instanceof Response) return gate;
  const { tenant } = principalForSession(gate);
  return NextResponse.json({
    builtin: builtinTemplates.map(({ id, name, kind, category, description, fields }) => ({
      id, name, kind, category, description, fields,
    })),
    cloned: listTemplates(tenant),
  });
}

export async function POST(request: Request) {
  const gate = await guard(request, { role: "member" });
  if (gate instanceof Response) return gate;

  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
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
