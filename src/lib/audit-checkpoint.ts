// Signed audit checkpoints.
//
// The audit log is a hash chain stored in the same database it protects, so an
// attacker who can write that database can rewrite history and recompute the
// chain. A checkpoint takes the chain head, signs it with a key the database
// never contains, and (optionally) ships it to an append-only sink outside the
// platform. Rewriting the log afterwards no longer verifies.
//
// QUILLON_AUDIT_KEY   HMAC key for checkpoint signatures (required).
// QUILLON_AUDIT_SINK  https:// endpoint or a file path outside the workspace;
//                     each checkpoint is appended there as one JSON line.
import { createHmac, timingSafeEqual } from "node:crypto";
import { getDb } from "@/lib/db";
import { guardedFetch } from "@/lib/net-guard";

export type AuditCheckpoint = {
  seq: number;
  org: string;
  auditCount: number;
  headHash: string | null;
  prevSignature: string | null;
  signature: string;
  exported: boolean;
  createdAt: string;
};

export class AuditKeyMissingError extends Error {
  constructor() {
    super(
      "Audit checkpoints need a signing key: set QUILLON_AUDIT_KEY (a random string kept outside the database, for example `openssl rand -hex 32`).",
    );
    this.name = "AuditKeyMissingError";
  }
}

function signingKey(): string {
  const key = process.env.QUILLON_AUDIT_KEY?.trim();
  if (!key || key.length < 16) throw new AuditKeyMissingError();
  return key;
}

type Unsigned = Pick<AuditCheckpoint, "seq" | "org" | "auditCount" | "headHash" | "prevSignature">;

function payloadOf(row: Unsigned): string {
  return JSON.stringify([row.seq, row.org, row.auditCount, row.headHash, row.prevSignature]);
}

function sign(row: Unsigned): string {
  return createHmac("sha256", signingKey()).update(payloadOf(row)).digest("hex");
}

function rowToCheckpoint(row: Record<string, unknown>): AuditCheckpoint {
  return {
    seq: Number(row.seq),
    org: String(row.org),
    auditCount: Number(row.audit_count),
    headHash: (row.head_hash as string | null) ?? null,
    prevSignature: (row.prev_signature as string | null) ?? null,
    signature: String(row.signature),
    exported: Number(row.exported) === 1,
    createdAt: String(row.created_at),
  };
}

/**
 * Signs the current audit head. Returns `created: false` when nothing has been
 * logged since the last checkpoint, so a scheduled caller can run often without
 * growing the table.
 */
export function createCheckpoint(org = "default"): { created: boolean; checkpoint?: AuditCheckpoint } {
  const db = getDb();
  const last = db
    .prepare("SELECT seq, audit_count, signature FROM audit_checkpoints WHERE org = ? ORDER BY seq DESC LIMIT 1")
    .get(org) as { seq: number; audit_count: number; signature: string } | undefined;
  const count = (db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE org = ?").get(org) as { n: number }).n;
  if (last && count <= last.audit_count) return { created: false };

  const head = db
    .prepare("SELECT hash FROM audit_log WHERE org = ? ORDER BY id DESC LIMIT 1")
    .get(org) as { hash: string | null } | undefined;
  const unsigned = {
    seq: (last?.seq ?? 0) + 1,
    org,
    auditCount: count,
    headHash: head?.hash ?? null,
    prevSignature: last?.signature ?? null,
  };
  const signature = sign(unsigned);
  const createdAt = new Date().toISOString();
  db.prepare(
    "INSERT INTO audit_checkpoints (org, audit_count, head_hash, prev_signature, signature, created_at) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(org, unsigned.auditCount, unsigned.headHash, unsigned.prevSignature, signature, createdAt);
  return { created: true, checkpoint: { ...unsigned, signature, exported: false, createdAt } };
}

export function listCheckpoints(org = "default", limit = 50): AuditCheckpoint[] {
  const rows = getDb()
    .prepare("SELECT * FROM audit_checkpoints WHERE org = ? ORDER BY seq DESC LIMIT ?")
    .all(org, limit) as Record<string, unknown>[];
  return rows.map(rowToCheckpoint);
}

export type CheckpointVerdict =
  | { ok: true; checked: number }
  | { ok: false; checked: number; broken: { seq: number; reason: string } };

/**
 * Re-verifies every checkpoint: the signature still matches, the chain of
 * signatures is unbroken, and the audit head each checkpoint signed is still
 * present in the log.
 */
export function verifyCheckpoints(org = "default"): CheckpointVerdict {
  const rows = listCheckpoints(org, 10_000).sort((a, b) => a.seq - b.seq);
  const db = getDb();
  const exists = db.prepare("SELECT 1 AS present FROM audit_log WHERE org = ? AND hash = ? LIMIT 1");
  let previous: string | null = null;
  for (const row of rows) {
    const expected = sign({
      seq: row.seq,
      org: row.org,
      auditCount: row.auditCount,
      headHash: row.headHash,
      prevSignature: row.prevSignature,
    });
    const matches =
      expected.length === row.signature.length &&
      timingSafeEqual(Buffer.from(expected), Buffer.from(row.signature));
    if (!matches) return { ok: false, checked: rows.length, broken: { seq: row.seq, reason: "signature does not verify" } };
    if (row.prevSignature !== previous) {
      return { ok: false, checked: rows.length, broken: { seq: row.seq, reason: "checkpoint chain is broken" } };
    }
    if (row.headHash && !exists.get(org, row.headHash)) {
      return {
        ok: false,
        checked: rows.length,
        broken: { seq: row.seq, reason: "audit rows signed by this checkpoint were rewritten or removed" },
      };
    }
    previous = row.signature;
  }
  return { ok: true, checked: rows.length };
}

/**
 * Appends a checkpoint to the configured sink outside the database. HTTP sinks
 * go through the egress guard; a file sink must be an absolute path.
 */
export async function exportCheckpoint(checkpoint: AuditCheckpoint): Promise<{ exported: boolean; detail: string }> {
  const sink = process.env.QUILLON_AUDIT_SINK?.trim();
  if (!sink) return { exported: false, detail: "QUILLON_AUDIT_SINK is not set." };
  const line = JSON.stringify({ kind: "quillon.audit.checkpoint", ...checkpoint });
  try {
    if (/^https?:\/\//i.test(sink)) {
      const res = await guardedFetch(sink, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: line,
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) return { exported: false, detail: `Sink answered ${res.status}.` };
    } else if (sink.startsWith("/")) {
      const { appendFile } = await import("node:fs/promises");
      await appendFile(sink, `${line}\n`, "utf8");
    } else {
      return { exported: false, detail: "QUILLON_AUDIT_SINK must be an https:// URL or an absolute path." };
    }
    getDb().prepare("UPDATE audit_checkpoints SET exported = 1 WHERE org = ? AND seq = ?").run(checkpoint.org, checkpoint.seq);
    return { exported: true, detail: `Checkpoint ${checkpoint.seq} exported.` };
  } catch (err) {
    return { exported: false, detail: err instanceof Error ? err.message : "Export failed." };
  }
}
