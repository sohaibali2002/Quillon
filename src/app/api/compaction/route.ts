async function secure(req: Request) {
  const gate = await guard(req);
  if (gate instanceof Response) return gate;
  return gate;
}

import { loadCompaction } from "@/lib/compaction";
import { getDb } from "@/lib/db";

import { guard } from "@/lib/guard";
// GET    /api/compaction?conversationId=...  -> stored rolling summary
// DELETE /api/compaction?conversationId=...  -> forget it (start fresh)
export async function GET(req: Request) {
  const denied = await secure(req);
  if (denied instanceof Response) return denied;

  const conversationId = new URL(req.url).searchParams.get("conversationId");
  if (!conversationId) {
    return Response.json(
      { error: { message: "conversationId query parameter is required." } },
      { status: 400 },
    );
  }
  return Response.json({ compaction: loadCompaction(conversationId) });
}

export async function DELETE(req: Request) {
  const denied = await secure(req);
  if (denied instanceof Response) return denied;

  const conversationId = new URL(req.url).searchParams.get("conversationId");
  if (!conversationId) {
    return Response.json(
      { error: { message: "conversationId query parameter is required." } },
      { status: 400 },
    );
  }
  getDb().prepare("DELETE FROM compactions WHERE conversation_id = ?").run(conversationId);
  return new Response(null, { status: 204 });
}
