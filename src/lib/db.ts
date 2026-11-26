// Persistence for memory, compaction state and MCP server config.
// Node's built-in sqlite (node:sqlite) keeps this dependency-free; the file
// lives in .data/quillon.db under the project root.
import { mkdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";

const DATA_DIR = path.join(process.cwd(), ".data");
const DB_FILE = path.join(DATA_DIR, "quillon.db");

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
];
