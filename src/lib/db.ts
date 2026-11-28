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
  {
    id: 16,
    name: "audit-checkpoints",
    sql: `
      CREATE TABLE audit_checkpoints (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        org TEXT NOT NULL DEFAULT 'default',
        audit_count INTEGER NOT NULL,
        head_hash TEXT,
        prev_signature TEXT,
        signature TEXT NOT NULL,
        exported INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      );
      CREATE INDEX IF NOT EXISTS audit_checkpoints_org ON audit_checkpoints (org, seq);
    `,
  },
  {
    id: 17,
    name: "tenancy-hardening",
    // Every row that can hold user data gets a tenant and (where it is personal)
    // an owner. Existing rows default to the sentinel tenant "legacy", which no
    // authenticated identity can ever resolve to, so pre-migration data is
    // invisible rather than shared.
    sql: `
      ALTER TABLE memories ADD COLUMN tenant_id TEXT NOT NULL DEFAULT 'legacy';
      ALTER TABLE memories ADD COLUMN owner_id TEXT NOT NULL DEFAULT 'legacy';
      CREATE INDEX IF NOT EXISTS memories_owner ON memories (tenant_id, owner_id, scope);
      CREATE TABLE IF NOT EXISTS conversations (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        owner_id TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      );
      CREATE INDEX IF NOT EXISTS conversations_owner ON conversations (tenant_id, owner_id);
      ALTER TABLE transactions ADD COLUMN plan_hash TEXT;
      ALTER TABLE transactions ADD COLUMN approved_hash TEXT;
      ALTER TABLE transactions ADD COLUMN second_approved_by TEXT;
      ALTER TABLE transactions ADD COLUMN second_approved_hash TEXT;
      ALTER TABLE transactions ADD COLUMN execution_lease TEXT;
      CREATE INDEX IF NOT EXISTS transactions_org ON transactions (org, created_at DESC);
      CREATE INDEX IF NOT EXISTS durable_runs_org ON durable_runs (org, created_at DESC);
      CREATE INDEX IF NOT EXISTS verification_reports_org ON verification_reports (org, created_at DESC);
      CREATE INDEX IF NOT EXISTS capabilities_org ON capabilities (org, expires_at);
    `,
  },
  {
    id: 18,
    name: "tenant-scope-resources",
    // Connector credentials, MCP server configs and uploaded files move under
    // tenant (and where personal, owner) scope. Legacy rows land in the
    // "legacy" sentinel tenant so nothing pre-migration is shared by accident.
    sql: `
      ALTER TABLE mcp_servers ADD COLUMN tenant_id TEXT NOT NULL DEFAULT 'legacy';
      CREATE INDEX IF NOT EXISTS mcp_servers_tenant ON mcp_servers (tenant_id, created_at);
      CREATE TABLE IF NOT EXISTS uploads (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        owner_id TEXT NOT NULL,
        filename TEXT NOT NULL,
        media_type TEXT NOT NULL,
        size INTEGER NOT NULL,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      );
      CREATE INDEX IF NOT EXISTS uploads_tenant ON uploads (tenant_id, owner_id);
    `,
  },
  {
    id: 19,
    name: "evaluation-forensics",
    sql: `
      CREATE TABLE IF NOT EXISTS forensics_documents (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        pursuit_id TEXT,
        kind TEXT NOT NULL,
        filename TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        origin TEXT NOT NULL,
        attestation_json TEXT NOT NULL,
        protective_order INTEGER NOT NULL DEFAULT 0,
        text TEXT NOT NULL,
        created_by TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      );
      CREATE INDEX IF NOT EXISTS forensics_documents_tenant ON forensics_documents (tenant_id, created_at);

      CREATE TABLE IF NOT EXISTS protest_decisions (
        id TEXT PRIMARY KEY,
        tribunal TEXT NOT NULL,
        docket TEXT NOT NULL,
        decision_date TEXT NOT NULL,
        agency TEXT NOT NULL,
        citation TEXT NOT NULL,
        url TEXT NOT NULL,
        outcome TEXT NOT NULL,
        text TEXT NOT NULL,
        extracted_json TEXT NOT NULL,
        extraction_version TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      );
      CREATE UNIQUE INDEX IF NOT EXISTS protest_decisions_docket ON protest_decisions (tribunal, docket) WHERE docket <> '';

      CREATE TABLE IF NOT EXISTS decision_grounds (
        decision_id TEXT NOT NULL,
        ground TEXT NOT NULL,
        holding TEXT NOT NULL,
        standard TEXT NOT NULL,
        passage TEXT NOT NULL,
        PRIMARY KEY (decision_id, ground)
      );

      CREATE TABLE IF NOT EXISTS twin_runs (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        pursuit_id TEXT,
        proposal_version TEXT,
        mode TEXT NOT NULL,
        model_versions TEXT NOT NULL,
        panel_outputs TEXT NOT NULL,
        report TEXT NOT NULL,
        created_by TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      );
      CREATE INDEX IF NOT EXISTS twin_runs_tenant ON twin_runs (tenant_id, created_at);

      CREATE TABLE IF NOT EXISTS twin_findings (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        tenant_id TEXT NOT NULL,
        factor TEXT NOT NULL,
        class TEXT NOT NULL,
        criterion_ref TEXT,
        proposal_quote TEXT NOT NULL,
        quote_verified INTEGER NOT NULL,
        reasoning TEXT NOT NULL,
        suggested_fix TEXT NOT NULL,
        precedent_refs TEXT NOT NULL,
        user_disposition TEXT
      );
      CREATE INDEX IF NOT EXISTS twin_findings_run ON twin_findings (run_id);

      CREATE TABLE IF NOT EXISTS debrief_runs (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        pursuit_id TEXT,
        debrief_document_id TEXT NOT NULL,
        report TEXT NOT NULL,
        created_by TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      );
      CREATE INDEX IF NOT EXISTS debrief_runs_tenant ON debrief_runs (tenant_id, created_at);

      CREATE TABLE IF NOT EXISTS debrief_findings (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        tenant_id TEXT NOT NULL,
        text TEXT NOT NULL,
        linked_criterion TEXT,
        verification TEXT NOT NULL,
        proposal_quote TEXT,
        quote_verified INTEGER NOT NULL,
        indicators TEXT NOT NULL,
        ground_refs TEXT NOT NULL,
        materiality TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS debrief_findings_run ON debrief_findings (run_id);

      CREATE TABLE IF NOT EXISTS protest_clocks (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        pursuit_id TEXT NOT NULL,
        notice_date TEXT NOT NULL,
        computed_deadlines_json TEXT NOT NULL,
        rule_sources_json TEXT NOT NULL,
        acknowledged_by TEXT,
        acknowledged_at TEXT,
        created_by TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      );
      CREATE INDEX IF NOT EXISTS protest_clocks_tenant ON protest_clocks (tenant_id, pursuit_id);

      CREATE TABLE IF NOT EXISTS forensics_calibration (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        run_id TEXT,
        factor TEXT NOT NULL,
        predicted TEXT NOT NULL,
        actual TEXT NOT NULL,
        created_by TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      );
      CREATE INDEX IF NOT EXISTS forensics_calibration_tenant ON forensics_calibration (tenant_id, factor);
    `,
  },
  {
    id: 20,
    name: "twin-findings-per-run",
    sql: `
      CREATE TABLE twin_findings_v2 (
        id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        tenant_id TEXT NOT NULL,
        factor TEXT NOT NULL,
        class TEXT NOT NULL,
        criterion_ref TEXT,
        proposal_quote TEXT NOT NULL,
        quote_verified INTEGER NOT NULL,
        reasoning TEXT NOT NULL,
        suggested_fix TEXT NOT NULL,
        precedent_refs TEXT NOT NULL,
        user_disposition TEXT,
        PRIMARY KEY (run_id, id)
      );
      INSERT OR IGNORE INTO twin_findings_v2 (id, run_id, tenant_id, factor, class, criterion_ref, proposal_quote, quote_verified, reasoning, suggested_fix, precedent_refs, user_disposition)
        SELECT id, run_id, tenant_id, factor, class, criterion_ref, proposal_quote, quote_verified, reasoning, suggested_fix, precedent_refs, user_disposition FROM twin_findings;
      DROP TABLE twin_findings;
      ALTER TABLE twin_findings_v2 RENAME TO twin_findings;
      CREATE INDEX IF NOT EXISTS twin_findings_run ON twin_findings (run_id);
      CREATE INDEX IF NOT EXISTS twin_findings_tenant_finding ON twin_findings (tenant_id, id);
    `,
  },
  {
    id: 21,
    name: "cloud-computers-tenant",
    sql: `
      CREATE TABLE cloud_computers_v2 (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL DEFAULT 'default',
        name TEXT NOT NULL,
        provider TEXT NOT NULL DEFAULT 'ssh',
        host TEXT NOT NULL,
        user TEXT NOT NULL DEFAULT 'ubuntu',
        workdir TEXT NOT NULL DEFAULT '/home/ubuntu/quillon',
        status TEXT NOT NULL DEFAULT 'unknown' CHECK (status IN ('unknown', 'online', 'offline')),
        last_checked_at TEXT,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      );
      INSERT OR IGNORE INTO cloud_computers_v2 (id, name, provider, host, user, workdir, status, last_checked_at, created_at)
        SELECT id, name, provider, host, user, workdir, status, last_checked_at, created_at FROM cloud_computers;
      DROP TABLE cloud_computers;
      ALTER TABLE cloud_computers_v2 RENAME TO cloud_computers;
      CREATE UNIQUE INDEX IF NOT EXISTS cloud_computers_tenant_name ON cloud_computers (tenant_id, name);
      CREATE INDEX IF NOT EXISTS cloud_computers_tenant ON cloud_computers (tenant_id, created_at);
    `,
  },
  {
    id: 22,
    name: "tenant-partition-brand-jobs",
    sql: `
      ALTER TABLE brand_kits ADD COLUMN tenant_id TEXT NOT NULL DEFAULT 'default';
      ALTER TABLE doc_templates ADD COLUMN tenant_id TEXT NOT NULL DEFAULT 'default';
      ALTER TABLE jobs ADD COLUMN tenant_id TEXT NOT NULL DEFAULT 'default';
      CREATE INDEX IF NOT EXISTS brand_kits_tenant ON brand_kits (tenant_id, updated_at);
      CREATE INDEX IF NOT EXISTS doc_templates_tenant ON doc_templates (tenant_id, created_at);
      CREATE INDEX IF NOT EXISTS jobs_tenant ON jobs (tenant_id, created_at);
    `,
  },
];
