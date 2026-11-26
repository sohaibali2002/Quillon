// Enterprise SSO: generic OIDC sign-in, first configured for Microsoft Entra ID.
// Enabled only when AUTH_ISSUER (and client credentials) are set; without them
// the app runs in open mode so local development needs no identity provider.
//
//   AUTH_ISSUER      e.g. https://login.microsoftonline.com/<tenant>/v2.0
//   AUTH_CLIENT_ID   application (client) ID from Entra app registration
//   AUTH_CLIENT_SECRET
//   AUTH_SCOPES      optional, default "openid profile email"
//   AUTH_SECRET      optional HMAC key; a value is derived at boot otherwise
//   AUTH_REDIRECT_URI optional; derived from the request when unset
//
// Sessions are HMAC-signed cookies (no dependency on a session store).
import { createHash, createHmac, timingSafeEqual, randomBytes } from "node:crypto";
import { cookies } from "next/headers";

export const SESSION_COOKIE = "quillon_session";
export const PKCE_COOKIE = "quillon_pkce";
const SESSION_TTL_S = 60 * 60 * 12;

export type SsoConfig = {
  issuer: string;
  clientId: string;
  clientSecret: string;
  scopes: string;
};

export function ssoConfig(): SsoConfig | null {
  const issuer = process.env.AUTH_ISSUER?.trim();
  const clientId = process.env.AUTH_CLIENT_ID?.trim();
  const clientSecret = process.env.AUTH_CLIENT_SECRET?.trim();
  if (!issuer || !clientId || !clientSecret) return null;
  return {
    issuer: issuer.replace(/\/$/, ""),
    clientId,
    clientSecret,
    scopes: process.env.AUTH_SCOPES?.trim() || "openid profile email",
  };
}

export type Session = {
  sub: string;
  name: string;
  email: string;
  roles: string[];
  exp: number;
};

export type IdpEndpoints = {
  authorization_endpoint: string;
  token_endpoint: string;
  userinfo_endpoint: string;
  end_session_endpoint?: string;
};

// RFC 8414 prefix-free then OIDC discovery path.
export async function discoverEndpoints(issuer: string): Promise<IdpEndpoints> {
  const res = await fetch(`${issuer}/.well-known/openid-configuration`, {
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`OIDC discovery failed with ${res.status}`);
  const doc = (await res.json()) as IdpEndpoints;
  if (!doc.authorization_endpoint || !doc.token_endpoint) {
    throw new Error("OIDC discovery document is missing endpoints");
  }
  return doc;
}

export function secretKey(): string {
  return process.env.AUTH_SECRET?.trim() || process.env.AUTH_CLIENT_SECRET?.trim() || "quillon-dev-key";
}

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

export function sign(payload: object): string {
  const body = b64url(JSON.stringify(payload));
  const mac = createHmac("sha256", secretKey()).update(body).digest("base64url");
  return `${body}.${mac}`;
}

export function verify(token: string | undefined): Session | null {
  if (!token) return null;
  const dot = token.lastIndexOf(".");
  if (dot <= 0) return null;
  const body = token.slice(0, dot);
  const mac = token.slice(dot + 1);
  const expected = createHmac("sha256", secretKey()).update(body).digest();
  let given: Buffer;
  try {
    given = Buffer.from(mac, "base64url");
  } catch {
    return null;
  }
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  let parsed: Session;
  try {
    parsed = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as Session;
  } catch {
    return null;
  }
  if (!parsed.exp || parsed.exp < Math.floor(Date.now() / 1000)) return null;
  if (!parsed.sub || typeof parsed.sub !== "string") return null;
  return parsed;
}

export async function readSession(): Promise<Session | null> {
  const jar = await cookies();
  return verify(jar.get(SESSION_COOKIE)?.value);
}

export function sessionCookieOptions() {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: SESSION_TTL_S,
  };
}

export function pkcePair() {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: b64url(createHash("sha256").update(verifier).digest()) };
}
