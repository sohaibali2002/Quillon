import { NextResponse } from "next/server";
import { addComputer, checkComputer, deleteComputer, listComputers } from "@/lib/cloud-computers";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function GET() {
  return NextResponse.json({ computers: listComputers() });
}

export async function POST(request: Request) {
  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  if (!body) return NextResponse.json({ error: "invalid body" }, { status: 400 });
  if (typeof body.checkId === "string") {
    const c = await checkComputer(body.checkId);
    return c ? NextResponse.json({ computer: c }) : NextResponse.json({ error: "not found" }, { status: 404 });
  }
  if (typeof body.host !== "string" || typeof body.name !== "string" || !body.host.trim() || !body.name.trim()) {
    return NextResponse.json({ error: "name and host are required" }, { status: 400 });
  }
  const computer = addComputer({
    name: body.name,
    host: body.host,
    provider: typeof body.provider === "string" ? body.provider : undefined,
    user: typeof body.user === "string" ? body.user : undefined,
    workdir: typeof body.workdir === "string" ? body.workdir : undefined,
  });
  return NextResponse.json({ computer });
}

export async function DELETE(request: Request) {
  const id = new URL(request.url).searchParams.get("computerId");
  if (!id) return NextResponse.json({ error: "computerId is required" }, { status: 400 });
  return NextResponse.json({ ok: deleteComputer(id) });
}
