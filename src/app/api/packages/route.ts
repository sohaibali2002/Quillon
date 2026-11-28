import { NextResponse } from "next/server";
import { industryPackages } from "@/lib/industry-packages";
import { createJob, listJobs } from "@/lib/jobs";
import { guard } from "@/lib/guard";
import { principalForSession } from "@/lib/rbac";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const gate = await guard(req);
  if (gate instanceof Response) return gate;
  const { tenant } = principalForSession(gate);
  const jobs = listJobs(tenant);
  return NextResponse.json({
    packages: industryPackages.map((p) => ({
      ...p,
      seedJobs: p.seedJobs?.map((j) => ({ ...j, seeded: jobs.some((x) => x.name === j.name) })),
    })),
  });
}

// Enable (seed) a package's jobs: POST { packageId }.
export async function POST(request: Request) {
  const gate = await guard(request, { role: "member" });
  if (gate instanceof Response) return gate;

  const { tenant } = principalForSession(gate);
  const body = (await request.json().catch(() => null)) as { packageId?: string } | null;
  const pkg = industryPackages.find((p) => p.id === body?.packageId);
  if (!pkg) return NextResponse.json({ error: "unknown packageId" }, { status: 400 });
  const seeded = (pkg.seedJobs ?? []).map((j) =>
    createJob({ name: j.name, prompt: j.prompt, schedule: j.schedule, packageId: pkg.id, tenant }),
  );
  return NextResponse.json({ seeded: seeded.map((j) => ({ id: j.id, name: j.name, schedule: j.schedule })) });
}
