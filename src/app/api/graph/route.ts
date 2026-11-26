// Knowledge graph API: search entities, expand relationships with provenance,
// upsert entities and edges (admin) and read graph stats.
import { z } from "zod";
import { guard, audit } from "@/lib/guard";
import { searchEntities, expand, getEntity, upsertEntity, addEdge, graphStats } from "@/lib/graph";

export const maxDuration = 30;

export async function GET(req: Request) {
  const gate = await guard(req);
  if (gate instanceof Response) return gate;
  const url = new URL(req.url);
  const org = "default";
  const q = url.searchParams.get("q");
  const type = url.searchParams.get("type") ?? undefined;
  const id = url.searchParams.get("id");
  if (id) {
    const got = getEntity(org, id);
    if (!got) return Response.json({ error: { message: "Unknown entity." } }, { status: 404 });
    return Response.json(got);
  }
  if (q) {
    const starts = searchEntities(org, q, type);
    return Response.json({ ...expand(org, starts.map((e) => e.id)), matched: starts });
  }
  return Response.json({ stats: graphStats(org) });
}

const schema = z.discriminatedUnion("op", [
  z.object({
    op: z.literal("upsert"),
    type: z.string().trim().min(1).max(80),
    name: z.string().trim().min(1).max(200),
    attrs: z.record(z.string(), z.unknown()).default({}),
    confidence: z.number().min(0).max(1).optional(),
  }),
  z.object({
    op: z.literal("link"),
    sourceId: z.string().min(1),
    relation: z.string().trim().min(1).max(80),
    targetId: z.string().min(1),
    sourceSystem: z.string().trim().min(1).max(80),
    sourceRef: z.string().max(200).nullable().optional(),
  }),
]);

export async function POST(req: Request) {
  const gate = await guard(req, { role: "member" });
  if (gate instanceof Response) return gate;
  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return Response.json({ error: { message: "Invalid graph operation." } }, { status: 400 });
  }
  const org = "default";
  const body = parsed.data;
  if (body.op === "upsert") {
    const e = upsertEntity(org, body.type, body.name, body.attrs, body.confidence ?? 1);
    audit(req, gate, "graph.upsert", e.id, { type: e.type, name: e.name });
    return Response.json({ entity: e });
  }
  const edge = addEdge(org, body.sourceId, body.relation, body.targetId, body.sourceSystem, body.sourceRef ?? null);
  if (!edge) return Response.json({ error: { message: "Both entities must exist in this org." } }, { status: 404 });
  audit(req, gate, "graph.link", edge.id, { relation: edge.relation });
  return Response.json({ edge });
}
