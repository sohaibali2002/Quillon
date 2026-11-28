// Persistence for memory, compaction state and MCP server config.
// Node's built-in sqlite (node:sqlite) keeps this dependency-free; the file
// lives in .data/quillon.db under the project root.
import { mkdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";

const DATA_DIR = path.join(process.env.DATABASE_PATH
  ? path.dirname(process.env.DATABASE_PATH)
  : path.join(process.cwd(), ".data"));
const DB_FILE = process.env.DATABASE_PATH?.trim() || path.join(DATA_DIR, "quillon.db");

let db: DatabaseSync | null = null;

export function getDb(): DatabaseSync {
  if (db) return db;

  mkdirSync(DATA_DIR, { recursive: true });
  db = new DatabaseSync(DB_FILE);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");

  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
  `);

  const applied = new Set<number>(
    db.prepare("SELECT id FROM schema_migrations").all().map((r) => Number(r.id)),
  );

  for (const m of MIGRATIONS) {
    if (applied.has(m.id)) continue;
    db.exec("BEGIN");
    try {
      db.exec(m.sql);
      db.prepare("INSERT INTO schema_migrations (id, name) VALUES (?, ?)").run(m.id, m.name);
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  }

  return db;
}

const MIGRATIONS = [
  {
    id: 1,
    name: "agent-memory",
    sql: `
      CREATE TABLE memories (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        scope TEXT NOT NULL DEFAULT 'conversation'
          CHECK (scope IN ('conversation', 'agent')),
        content TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      );
      CREATE INDEX idx_memories_conversation ON memories (conversation_id);
      CREATE INDEX idx_memories_scope ON memories (scope);
    `,
  },
  {
    id: 2,
    name: "context-compaction",
    sql: `
      CREATE TABLE compactions (
        conversation_id TEXT PRIMARY KEY,
        summary TEXT NOT NULL,
        compacted_count INTEGER NOT NULL DEFAULT 0,
        token_estimate INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      );
    `,
  },
  {
    id: 3,
    name: "mcp-servers",
    sql: `
      CREATE TABLE mcp_servers (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        transport TEXT NOT NULL CHECK (transport IN ('http', 'sse', 'stdio')),
        url TEXT,
        command TEXT,
        args TEXT NOT NULL DEFAULT '[]',
        env TEXT NOT NULL DEFAULT '{}',
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      );
    `,
  },
  {
    id: 4,
    name: "brand-kits-and-assets",
    sql: `
      CREATE TABLE brand_kits (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        colors TEXT NOT NULL DEFAULT '{}',
        fonts TEXT NOT NULL DEFAULT '{}',
        guidelines TEXT NOT NULL DEFAULT '',
        voice TEXT NOT NULL DEFAULT '',
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      );
      CREATE TABLE brand_assets (
        id TEXT PRIMARY KEY,
        kit_id TEXT NOT NULL REFERENCES brand_kits(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        kind TEXT NOT NULL DEFAULT 'logo',
        mime TEXT NOT NULL DEFAULT 'image/png',
        data TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      );
      CREATE INDEX idx_brand_assets_kit ON brand_assets (kit_id);
    `,
  },
  {
    id: 5,
    name: "document-templates",
    sql: `
      CREATE TABLE doc_templates (
        id TEXT PRIMARY KEY,
        kit_id TEXT REFERENCES brand_kits(id) ON DELETE SET NULL,
        name TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('pptx', 'docx', 'xlsx')),
        source TEXT NOT NULL DEFAULT 'builtin' CHECK (source IN ('builtin', 'cloned', 'custom')),
        definition TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      );
    `,
  },
  {
    id: 6,
    name: "unattended-jobs",
    sql: `
      CREATE TABLE jobs (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        prompt TEXT NOT NULL,
        model TEXT,
        schedule TEXT NOT NULL DEFAULT 'manual'
          CHECK (schedule IN ('manual', 'hourly', 'daily', 'weekly')),
        package_id TEXT,
        enabled INTEGER NOT NULL DEFAULT 1,
        last_run_at TEXT,
        next_run_at TEXT,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      );
      CREATE TABLE job_runs (
        id TEXT PRIMARY KEY,
        job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
        status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'done', 'error')),
        output TEXT NOT NULL DEFAULT '',
        error TEXT,
        duration_ms INTEGER,
        started_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      );
      CREATE INDEX idx_job_runs_job ON job_runs (job_id);
    `,
  },
  {
    id: 7,
    name: "cloud-computers",
    sql: `
      CREATE TABLE cloud_computers (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        provider TEXT NOT NULL DEFAULT 'ssh',
        host TEXT NOT NULL,
        user TEXT NOT NULL DEFAULT 'ubuntu',
        workdir TEXT NOT NULL DEFAULT '/home/ubuntu/quillon',
        status TEXT NOT NULL DEFAULT 'unknown' CHECK (status IN ('unknown', 'online', 'offline')),
        last_checked_at TEXT,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      );
    `,
  },
  {
    id: 8,
    name: "durable-execution",
    sql: `
      CREATE TABLE durable_runs (
        id TEXT PRIMARY KEY,
        org TEXT NOT NULL DEFAULT 'default',
        kind TEXT NOT NULL,
        input TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending'
          CHECK (status IN ('pending','running','paused','done','error','dead')),
        priority INTEGER NOT NULL DEFAULT 5,
        attempts INTEGER NOT NULL DEFAULT 0,
        max_attempts INTEGER NOT NULL DEFAULT 3,
        checkpoint TEXT,
        result TEXT,
        error TEXT,
        worker_id TEXT,
        lease_until TEXT,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      );
      CREATE INDEX idx_durable_runs_lease ON durable_runs (status, priority, lease_until);
      CREATE TABLE durable_steps (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT NOT NULL REFERENCES durable_runs(id) ON DELETE CASCADE,
        seq INTEGER NOT NULL,
        name TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','running','done','error','skipped')),
        input TEXT,
        output TEXT,
        error TEXT,
        started_at TEXT,
        finished_at TEXT,
        UNIQUE (run_id, seq)
      );
    `,
  },
  {
    id: 9,
    name: "transaction-engine",
    sql: `
      CREATE TABLE transactions (
        id TEXT PRIMARY KEY,
        org TEXT NOT NULL DEFAULT 'default',
        title TEXT NOT NULL,
        intent TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'planned'
          CHECK (status IN ('planned','simulated','awaiting_approval','executing','verifying','done','failed','compensated','rejected')),
        plan TEXT NOT NULL,
        simulation TEXT,
        verification TEXT,
        created_by TEXT,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      );
      CREATE TABLE transaction_actions (
        id TEXT PRIMARY KEY,
        transaction_id TEXT NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
        seq INTEGER NOT NULL,
        kind TEXT NOT NULL,
        target TEXT NOT NULL,
        payload TEXT NOT NULL,
        expected TEXT,
        undo TEXT,
        status TEXT NOT NULL DEFAULT 'pending'
          CHECK (status IN ('pending','executed','failed','compensated','skipped')),
        executed_result TEXT,
        executed_at TEXT,
        UNIQUE (transaction_id, seq)
      );
      CREATE TABLE agent_replay (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        kind TEXT NOT NULL,
        data TEXT NOT NULL
      );
      CREATE INDEX idx_agent_replay_run ON agent_replay (run_id, seq);
    `,
  },
  {
    id: 10,
    name: "capability-security",
    sql: `
      CREATE TABLE capabilities (
        id TEXT PRIMARY KEY,
        org TEXT NOT NULL DEFAULT 'default',
        subject TEXT NOT NULL,
        connector TEXT NOT NULL,
        action TEXT NOT NULL,
        resource TEXT,
        scope TEXT NOT NULL,
        issued_by TEXT,
        issued_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        expires_at TEXT NOT NULL,
        used_count INTEGER NOT NULL DEFAULT 0,
        max_uses INTEGER,
        revoked_at TEXT
      );
      CREATE INDEX idx_capabilities_subject ON capabilities (subject, expires_at);
    `,
  },
  {
    id: 11,
    name: "knowledge-graph",
    sql: `
      CREATE TABLE kg_entities (
        id TEXT PRIMARY KEY,
        org TEXT NOT NULL DEFAULT 'default',
        type TEXT NOT NULL,
        name TEXT NOT NULL,
        attrs TEXT NOT NULL DEFAULT '{}',
        confidence REAL NOT NULL DEFAULT 1.0,
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        UNIQUE (org, type, name)
      );
      CREATE TABLE kg_edges (
        id TEXT PRIMARY KEY,
        org TEXT NOT NULL DEFAULT 'default',
        source_id TEXT NOT NULL REFERENCES kg_entities(id) ON DELETE CASCADE,
        relation TEXT NOT NULL,
        target_id TEXT NOT NULL REFERENCES kg_entities(id) ON DELETE CASCADE,
        source_system TEXT NOT NULL,
        source_ref TEXT,
        observed_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        UNIQUE (org, source_id, relation, target_id, source_system, source_ref)
      );
    `,
  },
  {
    id: 12,
    name: "audit-log",
    sql: `
      CREATE TABLE audit_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        org TEXT NOT NULL DEFAULT 'default',
        actor TEXT NOT NULL,
        action TEXT NOT NULL,
        resource TEXT NOT NULL,
        detail TEXT NOT NULL DEFAULT '{}',
        ip TEXT,
        at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      );
    `,
  },
  {
    id: 14,
    name: "transaction-approver",
    sql: `
      ALTER TABLE transactions ADD COLUMN approved_by TEXT;
    `,
  },
  {
    id: 13,
    name: "verification-reports",
    sql: `
      CREATE TABLE verification_reports (
        id TEXT PRIMARY KEY,
        org TEXT NOT NULL DEFAULT 'default',
        target_kind TEXT NOT NULL,
        target_name TEXT NOT NULL,
        verdict TEXT NOT NULL CHECK (verdict IN ('pass','warn','fail')),
        checks TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      );
    `,
  },
  {
    id: 15,
    name: "security-hardening",
    sql: `
      ALTER TABLE mcp_servers ADD COLUMN tool_pin TEXT;
      CREATE TABLE session_revocations (
        subject TEXT PRIMARY KEY,
        revoked_before INTEGER NOT NULL DEFAULT 0,
        reason TEXT,
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      );
      ALTER TABLE audit_log ADD COLUMN prev_hash TEXT;
      ALTER TABLE audit_log ADD COLUMN hash TEXT;
      CREATE INDEX IF NOT EXISTS audit_log_org ON audit_log (org, id);
    `,
  },
];
