import { NextResponse } from "next/server";
import { createJob, deleteJob, listJobs, listRuns, runJob, updateJob } from "@/lib/jobs";
import { guard } from "@/lib/guard";
import { principalForSession } from "@/lib/rbac";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

// Jobs hold prompts and run with the platform's model keys: members own them,
// viewers can read the schedule, and everything is scoped to the caller's tenant.
async function reader(req: Request) {
  const gate = await guard(req);
  if (gate instanceof Response) return { denied: gate };
  return { denied: null as null, tenant: principalForSession(gate).tenant };
}

async function writer(req: Request) {
  const gate = await guard(req, { role: "member" });
  if (gate instanceof Response) return { denied: gate };
  return { denied: null as null, tenant: principalForSession(gate).tenant };
}

export async function GET(request: Request) {
  const { denied, tenant } = await reader(request);
  if (denied) return denied;

  const jobId = new URL(request.url).searchParams.get("jobId");
  if (jobId) {
    if (!listJobs(tenant).some((j) => j.id === jobId)) {
      return NextResponse.json({ error: "not found" }, { status: 404 });
    }
    return NextResponse.json({ runs: listRuns(jobId) });
  }
  return NextResponse.json({ jobs: listJobs(tenant) });
}

export async function POST(request: Request) {
  const { denied, tenant } = await writer(request);
  if (denied) return denied;

  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return NextResponse.json({ error: "invalid body" }, { status: 400 });
  // POST { runId } runs an existing job (manual or from cron).
  if (typeof body.runId === "string") {
    if (!listJobs(tenant).some((j) => j.id === body.runId)) {
      return NextResponse.json({ error: "not found" }, { status: 404 });
    }
    try {
      const run = await runJob(body.runId);
      return NextResponse.json({ run });
    } catch (err) {
      return NextResponse.json({ error: err instanceof Error ? err.message : "run failed" }, { status: 400 });
    }
  }
  if (typeof body.name !== "string" || typeof body.prompt !== "string" || !body.name.trim() || !body.prompt.trim()) {
    return NextResponse.json({ error: "name and prompt are required" }, { status: 400 });
  }
  const job = createJob({
    name: body.name,
    prompt: body.prompt,
    model: typeof body.model === "string" ? body.model : undefined,
    schedule: body.schedule as "manual" | "hourly" | "daily" | "weekly" | undefined,
    packageId: typeof body.packageId === "string" ? body.packageId : undefined,
    tenant,
  });
  return NextResponse.json({ job });
}

export async function PUT(request: Request) {
  const { denied, tenant } = await writer(request);
  if (denied) return denied;

  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body.id !== "string") return NextResponse.json({ error: "id is required" }, { status: 400 });
  const job = updateJob(
    body.id,
    {
      name: typeof body.name === "string" ? body.name : undefined,
      prompt: typeof body.prompt === "string" ? body.prompt : undefined,
      model: typeof body.model === "string" ? body.model : undefined,
      schedule: body.schedule as "manual" | "hourly" | "daily" | "weekly" | undefined,
      enabled: typeof body.enabled === "boolean" ? body.enabled : undefined,
    },
    tenant,
  );
  return job ? NextResponse.json({ job }) : NextResponse.json({ error: "not found" }, { status: 404 });
}

export async function DELETE(request: Request) {
  const { denied, tenant } = await writer(request);
  if (denied) return denied;

  const id = new URL(request.url).searchParams.get("jobId");
  if (!id) return NextResponse.json({ error: "jobId is required" }, { status: 400 });
  return NextResponse.json({ ok: deleteJob(id, tenant) });
}
