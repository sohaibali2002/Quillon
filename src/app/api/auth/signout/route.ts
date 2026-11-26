import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { SESSION_COOKIE, PKCE_COOKIE } from "@/lib/auth";

export async function POST() {
  const jar = await cookies();
  jar.delete(SESSION_COOKIE);
  jar.delete(PKCE_COOKIE);
  return NextResponse.json({ ok: true });
}

export async function GET() {
  return NextResponse.json({ error: "Use POST to sign out" }, { status: 405 });
}
