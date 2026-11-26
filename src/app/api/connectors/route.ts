import { NextRequest, NextResponse } from "next/server";
import { CONNECTOR_CATALOG, connectedIds, deleteToken, readToken } from "@/lib/connectors";
import { ENTERPRISE_RECIPES } from "@/lib/enterprise-platforms";

// GET /api/connectors — catalog with per-connector connection state.
// Secrets are never returned; only the last four characters for recognition.
export async function GET() {
  const connected = new Set(connectedIds());
  const catalog = CONNECTOR_CATALOG.map((c) => {
    const token = readToken(c.id);
    const actions = ENTERPRISE_RECIPES.find((r) => r.id === c.id)?.actions ?? [];
    return {
      id: c.id,
      name: c.name,
      category: c.category,
      description: c.description,
      auth: c.auth,
      scopes: c.scopes,
      docs: c.docs,
      connected: connected.has(c.id),
      tokenHint: token ? `••••${token.slice(-4)}` : null,
      tools: actions.map((a) => ({ id: `ent_${c.id}_${a.id}`, description: a.description })),
    };
  });
  return NextResponse.json({ connectors: catalog });
}

// DELETE /api/connectors — disconnect one connector: /api/connectors?id=slack
export async function DELETE(req: NextRequest) {
  const id = req.nextUrl.searchParams.get("id");
  if (!id || !CONNECTOR_CATALOG.some((c) => c.id === id)) {
    return NextResponse.json({ error: "Unknown connector" }, { status: 404 });
  }
  deleteToken(id);
  return NextResponse.json({ ok: true });
}
