import { NextRequest, NextResponse } from "next/server";
import { CONNECTOR_CATALOG, saveToken } from "@/lib/connectors";

// POST /api/connectors/token — store a credential for a connector.
// For `pat` connectors this is the token itself. For `oauth2` connectors the
// user pastes an access token obtained from the provider's own consent screen
// (or from your IdP); it is encrypted with AES-256-GCM before it is written.
export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => null)) as
    | { connectorId?: string; token?: string; account?: string }
    | null;
  const def = CONNECTOR_CATALOG.find((c) => c.id === body?.connectorId);
  if (!def) return NextResponse.json({ error: "Unknown connector" }, { status: 404 });
  const token = body?.token?.trim();
  if (!token) return NextResponse.json({ error: "A token is required" }, { status: 400 });

  saveToken(def.id, def.auth === "oauth2" ? "oauth2" : "pat", token, body?.account?.trim() || null, def.scopes);
  return NextResponse.json({ ok: true, connectorId: def.id, connected: true });
}
