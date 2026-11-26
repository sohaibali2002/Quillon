// Universal business knowledge graph: entities (customers, deals, contracts,
// tickets, invoices...) and permission-scoped edges that carry provenance —
// which connected system observed the relationship, a pointer to the source
// record and when it was seen — so answers can cite where every claim came from.
import { randomUUID } from "node:crypto";
import { getDb } from "@/lib/db";

export interface Entity {
  id: string;
  org: string;
  type: string;
  name: string;
  attrs: Record<string, unknown>;
  confidence: number;
  updated_at: string;
}

export interface Edge {
  id: string;
  source_id: string;
  relation: string;
  target_id: string;
  source_system: string;
  source_ref: string | null;
  observed_at: string;
}

export function upsertEntity(org: string, type: string, name: string, attrs: Record<string, unknown> = {}, confidence = 1): Entity {
  const db = getDb();
  const id = randomUUID();
  db.prepare(
    `INSERT INTO kg_entities (id, org, type, name, attrs, confidence) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(org, type, name) DO UPDATE SET attrs = excluded.attrs, confidence = excluded.confidence,
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`,
  ).run(id, org, type, name, JSON.stringify(attrs), confidence);
  const row = db.prepare("SELECT * FROM kg_entities WHERE org = ? AND type = ? AND name = ?").get(org, type, name) as Record<string, unknown>;
  return rowToEntity(row);
}

function rowToEntity(r: Record<string, unknown>): Entity {
  return {
    id: String(r.id),
    org: String(r.org),
    type: String(r.type),
    name: String(r.name),
    attrs: JSON.parse(String(r.attrs ?? "{}")),
    confidence: Number(r.confidence),
    updated_at: String(r.updated_at),
  };
}

export function addEdge(
  org: string,
  sourceId: string,
  relation: string,
  targetId: string,
  sourceSystem: string,
  sourceRef?: string | null,
): Edge | null {
  const db = getDb();
  const exists = db.prepare("SELECT id FROM kg_entities WHERE id = ? AND org = ?").get(sourceId, org)
    && db.prepare("SELECT id FROM kg_entities WHERE id = ? AND org = ?").get(targetId, org);
  if (!exists) return null;
  const id = randomUUID();
  db.prepare(
    `INSERT INTO kg_edges (id, org, source_id, relation, target_id, source_system, source_ref)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(org, source_id, relation, target_id, source_system, source_ref) DO NOTHING`,
  ).run(id, org, sourceId, relation, targetId, sourceSystem, sourceRef ?? null);
  const ref: string | null = sourceRef ?? null;
  const row = ref === null
    ? db.prepare("SELECT * FROM kg_edges WHERE org=? AND source_id=? AND relation=? AND target_id=? AND source_system=? AND source_ref IS NULL").get(org, sourceId, relation, targetId, sourceSystem)
    : db.prepare("SELECT * FROM kg_edges WHERE org=? AND source_id=? AND relation=? AND target_id=? AND source_system=? AND source_ref=?").get(org, sourceId, relation, targetId, sourceSystem, ref);
  return row ? rowToEdge(row as Record<string, unknown>) : null;
}

function rowToEdge(r: Record<string, unknown>): Edge {
  return {
    id: String(r.id),
    source_id: String(r.source_id),
    relation: String(r.relation),
    target_id: String(r.target_id),
    source_system: String(r.source_system),
    source_ref: (r.source_ref as string | null) ?? null,
    observed_at: String(r.observed_at),
  };
}

export function getEntity(org: string, id: string): { entity: Entity; edges: (Edge & { direction: "out" | "in"; other: Entity })[] } | null {
  const db = getDb();
  const row = db.prepare("SELECT * FROM kg_entities WHERE org = ? AND id = ?").get(org, id) as Record<string, unknown> | undefined;
  if (!row) return null;
  const entity = rowToEntity(row);
  const edges: (Edge & { direction: "out" | "in"; other: Entity })[] = [];
  const out = db.prepare("SELECT * FROM kg_edges WHERE org = ? AND source_id = ?").all(org, id) as Record<string, unknown>[];
  for (const e of out) {
    const other = db.prepare("SELECT * FROM kg_entities WHERE id = ?").get(String(e.target_id)) as Record<string, unknown> | undefined;
    if (other) edges.push({ ...rowToEdge(e), direction: "out", other: rowToEntity(other) });
  }
  const inc = db.prepare("SELECT * FROM kg_edges WHERE org = ? AND target_id = ?").all(org, id) as Record<string, unknown>[];
  for (const e of inc) {
    const other = db.prepare("SELECT * FROM kg_entities WHERE id = ?").get(String(e.source_id)) as Record<string, unknown> | undefined;
    if (other) edges.push({ ...rowToEdge(e), direction: "in", other: rowToEntity(other) });
  }
  return { entity, edges };
}

export function searchEntities(org: string, q: string, type?: string, limit = 25): Entity[] {
  const like = `%${q}%`;
  const rows = type
    ? (getDb().prepare("SELECT * FROM kg_entities WHERE org = ? AND type = ? AND (name LIKE ? OR attrs LIKE ?) ORDER BY confidence DESC LIMIT ?").all(org, type, like, like, limit) as Record<string, unknown>[])
    : (getDb().prepare("SELECT * FROM kg_entities WHERE org = ? AND (name LIKE ? OR attrs LIKE ?) ORDER BY confidence DESC LIMIT ?").all(org, like, like, limit) as Record<string, unknown>[]);
  return rows.map(rowToEntity);
}

// Multi-hop question: start from entities matching a query and expand up to
// `depth` hops, returning every edge with provenance. Callers (the chat tool)
// present this as "here is what we know and where each fact came from".
export function expand(org: string, startIds: string[], depth = 2, maxNodes = 50): { nodes: Entity[]; edges: (Edge & { direction: "out" | "in"; other: Entity })[] } {
  const nodes = new Map<string, Entity>();
  const edges: (Edge & { direction: "out" | "in"; other: Entity })[] = [];
  let frontier = startIds;
  for (const id of frontier) {
    const got = getEntity(org, id);
    if (got) nodes.set(id, got.entity);
  }
  for (let d = 0; d < depth && frontier.length && nodes.size < maxNodes; d++) {
    const next: string[] = [];
    for (const id of frontier) {
      const got = getEntity(org, id);
      if (!got) continue;
      for (const e of got.edges) {
        edges.push(e);
        if (!nodes.has(e.other.id) && nodes.size < maxNodes) {
          nodes.set(e.other.id, e.other);
          next.push(e.other.id);
        }
      }
    }
    frontier = next;
  }
  return { nodes: [...nodes.values()], edges };
}

export function graphStats(org: string) {
  const db = getDb();
  const entities = Number((db.prepare("SELECT COUNT(*) AS n FROM kg_entities WHERE org = ?").get(org) as { n: number }).n);
  const edges = Number((db.prepare("SELECT COUNT(*) AS n FROM kg_edges WHERE org = ?").get(org) as { n: number }).n);
  const byType = db.prepare("SELECT type, COUNT(*) AS n FROM kg_entities WHERE org = ? GROUP BY type ORDER BY n DESC").all(org) as Record<string, unknown>[];
  return {
    entities,
    edges,
    byType: byType.map((r) => ({ type: String(r.type), count: Number(r.n) })),
  };
}
