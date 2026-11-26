import { NextResponse } from "next/server";
import { readSession, ssoConfig } from "@/lib/auth";

// GET /api/auth/session — who is signed in, and whether SSO is enforced.
export async function GET() {
  const config = ssoConfig();
  const session = await readSession();
  return NextResponse.json({
    ssoEnabled: Boolean(config),
    signedIn: Boolean(session),
    user: session ? { name: session.name, email: session.email, roles: session.roles } : null,
  });
}
