async function secure(req: Request) {
  const gate = await guard(req);
  if (gate instanceof Response) return gate;
  return gate;
}

import { NextResponse } from "next/server";
import { createJob, deleteJob, listJobs, listRuns, runJob, updateJob } from "@/lib/jobs";

import { guard } from "@/lib/guard";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function GET(request: Request) {
  const denied = await secure(request);
  if (denied instanceof Response) return denied;

  const jobId = new URL(request.url).searchParams.get("jobId");
  if (jobId) return NextResponse.json({ runs: listRuns(jobId) });
  return NextResponse.json({ jobs: listJobs() });
}

export async function POST(request: Request) {
  const denied = await secure(request);
  if (denied instanceof Response) return denied;

  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  if (!body) return NextResponse.json({ error: "invalid body" }, { status: 400 });
  // POST { runId } runs an existing job (manual or from cron).
  if (typeof body.runId === "string") {
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
  });
  return NextResponse.json({ job });
}

export async function PUT(request: Request) {
  const denied = await secure(request);
  if (denied instanceof Response) return denied;

  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  if (!body || typeof body.id !== "string") return NextResponse.json({ error: "id is required" }, { status: 400 });
  const job = updateJob(body.id, {
    name: typeof body.name === "string" ? body.name : undefined,
    prompt: typeof body.prompt === "string" ? body.prompt : undefined,
    model: typeof body.model === "string" ? body.model : undefined,
    schedule: body.schedule as "manual" | "hourly" | "daily" | "weekly" | undefined,
    enabled: typeof body.enabled === "boolean" ? body.enabled : undefined,
  });
  return job ? NextResponse.json({ job }) : NextResponse.json({ error: "not found" }, { status: 404 });
}

export async function DELETE(request: Request) {
  const denied = await secure(request);
  if (denied instanceof Response) return denied;

  const id = new URL(request.url).searchParams.get("jobId");
  if (!id) return NextResponse.json({ error: "jobId is required" }, { status: 400 });
  return NextResponse.json({ ok: deleteJob(id) });
}
