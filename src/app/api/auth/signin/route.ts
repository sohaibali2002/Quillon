import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { discoverEndpoints, pkcePair, ssoConfig, PKCE_COOKIE } from "@/lib/auth";

// GET /api/auth/signin?redirect=/workspace — starts the OIDC authorization-code
// flow with PKCE against the configured identity provider (Entra ID et al).
export async function GET(req: NextRequest) {
  const config = ssoConfig();
  if (!config) {
    return NextResponse.json(
      { error: "SSO is not configured. Set AUTH_ISSUER, AUTH_CLIENT_ID and AUTH_CLIENT_SECRET." },
      { status: 503 },
    );
  }

  const redirectTo = safeReturn(req.nextUrl.searchParams.get("redirect") ?? "/workspace");
  let endpoints: Awaited<ReturnType<typeof discoverEndpoints>>;
  try {
    endpoints = await discoverEndpoints(config.issuer);
  } catch {
    return NextResponse.json({ error: "Identity provider is unreachable" }, { status: 502 });
  }

  const { verifier, challenge } = pkcePair();
  const state = crypto.randomUUID();
  // Nonce binds the ID token to this browser's sign-in attempt; the callback
  // rejects a token that carries a different one.
  const nonce = crypto.randomUUID();

  const jar = await cookies();
  jar.set(PKCE_COOKIE, JSON.stringify({ verifier, state, nonce, redirectTo }), {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 600,
  });

  const redirectUri =
    process.env.AUTH_REDIRECT_URI?.trim() ||
    `${req.nextUrl.origin}/api/auth/callback`;

  const authorizeUrl = new URL(endpoints.authorization_endpoint);
  authorizeUrl.searchParams.set("response_type", "code");
  authorizeUrl.searchParams.set("client_id", config.clientId);
  authorizeUrl.searchParams.set("redirect_uri", redirectUri);
  authorizeUrl.searchParams.set("scope", config.scopes);
  authorizeUrl.searchParams.set("state", state);
  authorizeUrl.searchParams.set("nonce", nonce);
  authorizeUrl.searchParams.set("code_challenge", challenge);
  authorizeUrl.searchParams.set("code_challenge_method", "S256");

  return NextResponse.redirect(authorizeUrl.toString());
}

function safeReturn(target: string): string {
  return target.startsWith("/") && !target.startsWith("//") ? target : "/workspace";
}
