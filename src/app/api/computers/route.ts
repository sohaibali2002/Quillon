import { NextResponse } from "next/server";
import { addComputer, checkComputer, deleteComputer, listComputers, sshTargetReason } from "@/lib/cloud-computers";
import { capabilitySubject, guard } from "@/lib/guard";
import { enforceRateLimit } from "@/lib/rate-limit";
import { principalForSession } from "@/lib/rbac";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

async function secure(req: Request) {
  // Registering a machine and probing it spawns ssh on this host: members only.
  const gate = await guard(req, { role: "member" });
  if (gate instanceof Response) return { denied: gate };
  return { denied: null as null, session: gate };
}

export async function GET(request: Request) {
  const { denied, session } = await secure(request);
  if (denied) return denied;
  const { tenant } = principalForSession(session);
  return NextResponse.json({ computers: listComputers(tenant) });
}

export async function POST(request: Request) {
  const { denied, session } = await secure(request);
  if (denied) return denied;

  const limited = enforceRateLimit(capabilitySubject(session), "computers", 20, 60_000);
  if (limited) return limited;

  const { tenant } = principalForSession(session);
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return NextResponse.json({ error: "invalid body" }, { status: 400 });
  if (typeof body.checkId === "string") {
    const c = await checkComputer(body.checkId, tenant);
    return c ? NextResponse.json({ computer: c }) : NextResponse.json({ error: "not found" }, { status: 404 });
  }
  if (typeof body.host !== "string" || typeof body.name !== "string" || !body.host.trim() || !body.name.trim()) {
    return NextResponse.json({ error: "name and host are required" }, { status: 400 });
  }
  const user = typeof body.user === "string" ? body.user : undefined;
  const problem = sshTargetReason(body.host.trim(), user ?? "ubuntu");
  if (problem) return NextResponse.json({ error: problem }, { status: 400 });
  let computer;
  try {
    computer = addComputer({
      name: body.name.trim(),
      host: body.host,
      provider: typeof body.provider === "string" ? body.provider : undefined,
      user,
      workdir: typeof body.workdir === "string" ? body.workdir : undefined,
      tenant,
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Could not register the machine." },
      { status: 400 },
    );
  }
  return NextResponse.json({ computer });
}

export async function DELETE(request: Request) {
  const { denied, session } = await secure(request);
  if (denied) return denied;

  const { tenant } = principalForSession(session);
  const id = new URL(request.url).searchParams.get("computerId");
  if (!id) return NextResponse.json({ error: "computerId is required" }, { status: 400 });
  const ok = deleteComputer(id, tenant);
  return NextResponse.json(ok ? { ok } : { error: "not found" }, { status: ok ? 200 : 404 });
}
