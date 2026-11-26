import { NextResponse } from "next/server";
import { setupStatus } from "@/lib/setup";

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json(setupStatus());
}
