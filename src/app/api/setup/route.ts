import { NextResponse } from "next/server";
import { guard } from "@/lib/guard";
import { setupStatus } from "@/lib/setup";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  // The onboarding view is public in open mode; a locked-down deployment asks
  // for a session before it will say what is configured.
  const gate = await guard(req);
  if (gate instanceof Response) return gate;
  return NextResponse.json(setupStatus());
}
