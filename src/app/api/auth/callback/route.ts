import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import {
  discoverEndpoints,
  ssoConfig,
  sign,
  SESSION_COOKIE,
  PKCE_COOKIE,
  sessionCookieOptions,
  type Session,
} from "@/lib/auth";

// GET /api/auth/callback — exchanges the authorization code, then issues the
// signed Quillon session cookie.
export async function GET(req: NextRequest) {
  const config = ssoConfig();
  if (!config) return NextResponse.json({ error: "SSO is not configured" }, { status: 503 });

  const code = req.nextUrl.searchParams.get("code");
  const state = req.nextUrl.searchParams.get("state");
  if (!code || !state) {
    return NextResponse.json({ error: "Missing code or state" }, { status: 400 });
  }

  const jar = await cookies();
  const raw = jar.get(PKCE_COOKIE)?.value;
  jar.delete(PKCE_COOKIE);
  if (!raw) return NextResponse.json({ error: "Sign-in attempt expired, try again" }, { status: 400 });

  let saved: { verifier: string; state: string; redirectTo: string };
  try {
    saved = JSON.parse(raw);
  } catch {
    return NextResponse.json({ error: "Sign-in state is unreadable" }, { status: 400 });
  }
  if (saved.state !== state) {
    return NextResponse.json({ error: "State mismatch" }, { status: 400 });
  }

  let endpoints: Awaited<ReturnType<typeof discoverEndpoints>>;
  try {
    endpoints = await discoverEndpoints(config.issuer);
  } catch {
    return NextResponse.json({ error: "Identity provider is unreachable" }, { status: 502 });
  }

  const redirectUri =
    process.env.AUTH_REDIRECT_URI?.trim() || `${req.nextUrl.origin}/api/auth/callback`;

  const tokenRes = await fetch(endpoints.token_endpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    signal: AbortSignal.timeout(10_000),
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      client_id: config.clientId,
      client_secret: config.clientSecret,
      code_verifier: saved.verifier,
    }),
  });
  if (!tokenRes.ok) {
    return NextResponse.json({ error: "Token exchange failed" }, { status: 401 });
  }
  const tokens = (await tokenRes.json()) as { access_token: string; expires_in?: number };

  const claims = await decodeIdClaims(endpoints.userinfo_endpoint, tokens.access_token);
  const now = Math.floor(Date.now() / 1000);
  const session: Session = {
    sub: String(claims.sub ?? ""),
    name: String(claims.name ?? claims.preferred_username ?? "Signed-in user"),
    email: String(claims.email ?? claims.preferred_username ?? ""),
    roles: Array.isArray(claims.roles) ? claims.roles.map(String) : [],
    iat: now,
    exp: now + Math.min(tokens.expires_in ?? 3600, 60 * 60 * 12),
  };

  const res = NextResponse.redirect(new URL(safeReturn(saved.redirectTo), req.nextUrl.origin));
  res.cookies.set(SESSION_COOKIE, sign(session), sessionCookieOptions());
  return res;
}

async function decodeIdClaims(userinfoEndpoint: string, accessToken: string) {
  const res = await fetch(userinfoEndpoint, {
    headers: { authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) return { sub: "" };
  return (await res.json()) as Record<string, unknown>;
}

function safeReturn(target: string): string {
  return target.startsWith("/") && !target.startsWith("//") ? target : "/workspace";
}
