import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { SESSION_COOKIE, PKCE_COOKIE, readSession, revokeSessions } from "@/lib/auth";

export async function POST() {
  // Delete the cookie and cut off the token server-side: a copied cookie stays
  // valid for its full lifetime otherwise.
  const session = await readSession();
  if (session) revokeSessions(session.sub);
  const jar = await cookies();
  jar.delete(SESSION_COOKIE);
  jar.delete(PKCE_COOKIE);
  return NextResponse.json({ ok: true });
}

export async function GET() {
  return NextResponse.json({ error: "Use POST to sign out" }, { status: 405 });
}
