// Deep native Salesforce integration, built against the official API docs
// (https://developer.salesforce.com/docs/apis). Goes well beyond the generic
// recipe actions: refresh-token sessions, SOQL/SOSL with automatic queryMore
// pagination, full sobject CRUD + external-id upsert, sObject collections,
// Composite (cross-object, referenceId-linked) requests, Bulk API 2.0 ingest
// and query jobs, global/object describe, and org limits.
//
// REST + Bulk API 2.0 version: v60.0.
import { tool, type Tool } from "ai";
import { z } from "zod";
import { readToken } from "./connectors";
import { runWithTenant, tenantScope } from "./tenant-context";
import { safeErrorMessage } from "./sanitize";

const API_VERSION = "v60.0";

/** Stored credential formats (Connectors panel token field):
 *  1. "https://myorg.my.salesforce.com|<access_token>"
 *  2. "https://login.salesforce.com|<refresh_token>|<client_id>|<client_secret>"
 *     — access token obtained via the refresh-token flow and cached in memory. */
export type SfCredential =
  | { kind: "session"; instanceUrl: string; accessToken: string }
  | { kind: "refresh"; loginUrl: string; refreshToken: string; clientId: string; clientSecret: string };

export function parseCredential(stored: string): SfCredential | null {
  const parts = stored.split("|").map((p) => p.trim()).filter(Boolean);
  if (parts.length >= 2 && /^https?:\/\//.test(parts[0])) {
    if (parts.length >= 4) {
      return {
        kind: "refresh",
        loginUrl: parts[0].replace(/\/$/, ""),
        refreshToken: parts[1],
        clientId: parts[2],
        clientSecret: parts[3],
      };
    }
    return { kind: "session", instanceUrl: parts[0].replace(/\/$/, ""), accessToken: parts[1] };
  }
  return null;
}

/** Salesforce error bodies are arrays of {message, errorCode, fields}. */
export function extractSfError(data: unknown): string | null {
  if (Array.isArray(data)) {
    const first = data.find((e) => e && typeof e === "object" && "message" in e);
    if (first) {
      const m = first as { message?: string; errorCode?: string };
      return m.errorCode ? `${m.errorCode}: ${m.message}` : (m.message ?? null);
    }
    return null;
  }
  if (data && typeof data === "object") {
    const d = data as Record<string, unknown>;
    if (typeof d.message === "string") return d.message;
    if (typeof d.error === "string") return d.error;
    if (typeof d.error_description === "string") return d.error_description;
  }
  return null;
}

/** Escape one CSV value per RFC 4180 (Bulk API 2.0 upload format). */
export function csvEscape(v: unknown): string {
  const s = v === null || v === undefined ? "" : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function csvRows(header: string[], rows: Record<string, unknown>[]): string {
  const lines = [header.map(csvEscape).join(",")];
  for (const r of rows) lines.push(header.map((h) => csvEscape(r[h])).join(","));
  return lines.join("\r\n") + "\r\n";
}

export class SfClient {
  private cred: SfCredential;
  private cachedToken: string | null = null;
  private instanceUrl: string;

  constructor(cred: SfCredential) {
    this.cred = cred;
    // Placeholder until a refresh proves the real instance (instance_url in the
    // token response is authoritative); session creds carry it directly.
    this.instanceUrl =
      cred.kind === "session" ? cred.instanceUrl : cred.loginUrl;
  }

  async accessToken(): Promise<string> {
    if (this.cred.kind === "session") return this.cred.accessToken;
    if (this.cachedToken) return this.cachedToken;
    const res = await fetch(`${this.cred.loginUrl}/services/oauth2/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: this.cred.refreshToken,
        client_id: this.cred.clientId,
        client_secret: this.cred.clientSecret,
      }).toString(),
      signal: AbortSignal.timeout(15_000),
    });
    const data: unknown = await res.json().catch(() => ({}));
    if (!res.ok) {
      const detail = extractSfError(data);
      throw new Error(`Salesforce token refresh failed with ${res.status}${detail ? `: ${detail}` : ""}`);
    }
    const d = data as { access_token?: string; instance_url?: string };
    if (!d.access_token) throw new Error("Salesforce token refresh returned no access_token");
    this.cachedToken = d.access_token;
    if (d.instance_url) this.instanceUrl = d.instance_url.replace(/\/$/, "");
    return d.access_token;
  }

  get instance(): string {
    return this.instanceUrl;
  }

  api(path: string): string {
    return `${this.instanceUrl}/services/data/${API_VERSION}/${path.replace(/^\/+/, "")}`;
  }

  /** One REST call. Retries once on a session-expiry 401 (refresh creds only). */
  async request(
    method: string,
    path: string,
    init?: { body?: unknown; contentType?: string; accept?: string; raw?: boolean },
  ): Promise<{ status: number; ok: boolean; data: unknown }> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const token = await this.accessToken();
      const headers: Record<string, string> = { authorization: `Bearer ${token}` };
      if (init?.accept) headers.accept = init.accept;
      let body: string | undefined;
      if (init?.body !== undefined) {
        headers["content-type"] = init.contentType ?? "application/json";
        body = typeof init.body === "string" ? init.body : JSON.stringify(init.body);
      }
      const res = await fetch(this.api(path), { method, headers, body, signal: AbortSignal.timeout(30_000) });
      if (res.status === 401 && attempt === 0 && this.cred.kind === "refresh") {
        this.cachedToken = null;
        continue;
      }
      if (res.status === 204) return { status: 204, ok: true, data: null };
      const data: unknown = init?.raw ? await res.text() : await res.json().catch(() => ({}));
      const ok = res.ok && !(typeof data === "object" && data !== null && "error" in data);
      return { status: res.status, ok, data };
    }
    throw new Error("unreachable");
  }

  /** SOQL with automatic queryMore: follows nextRecordsUrl until maxRecords. */
  async queryAll(soql: string, opts: { all?: boolean; maxRecords?: number } = {}) {
    const cap = Math.min(100_000, Math.max(200, opts.maxRecords ?? 2000));
    const params = new URLSearchParams({ q: soql });
    const first = await this.request("GET", `query${opts.all ? "All" : ""}?${params}`);
    if (!first.ok) return first;
    let records: unknown[] = Array.isArray((first.data as { records?: unknown[] }).records)
      ? (first.data as { records: unknown[] }).records
      : [];
    let next: string | null = (first.data as { nextRecordsUrl?: string }).nextRecordsUrl ?? null;
    let data = first.data as Record<string, unknown>;
    while (next && records.length < cap) {
      const path = next.replace(/^.*\/services\/data\/[^/]+\//, "");
      const page = await this.request("GET", path);
      if (!page.ok) break;
      data = page.data as Record<string, unknown>;
      const pageRecords = Array.isArray((page.data as { records?: unknown[] }).records)
        ? (page.data as { records: unknown[] }).records
        : [];
      records = records.concat(pageRecords);
      next = (page.data as { nextRecordsUrl?: string }).nextRecordsUrl ?? null;
    }
    return { status: 200, ok: true, data: { ...data, records, done: !next, fetched: records.length } };
  }

  /** Bulk API 2.0: open an ingest job (insert/update/upsert/delete/hardDelete). */
  async createIngestJob(job: {
    operation: string;
    sobject: string;
    externalIdField?: string;
    assignmentRuleId?: string;
  }) {
    const body: Record<string, unknown> = {
      operation: job.operation,
      object: job.sobject,
      contentType: "CSV",
      lineEnding: "LF",
    };
    if (job.externalIdField) body.externalIdFieldName = job.externalIdField;
    if (job.assignmentRuleId) body.assignmentRuleId = job.assignmentRuleId;
    return this.request("POST", "jobs/ingest", { body });
  }

  async uploadIngestBatch(jobId: string, csv: string) {
    return this.request("PUT", `jobs/ingest/${jobId}/batches`, { body: csv, contentType: "text/csv", raw: true });
  }

  async closeIngestJob(jobId: string) {
    return this.request("PATCH", `jobs/ingest/${jobId}`, { body: { state: "UploadComplete" } });
  }

  async bulkJobStatus(jobId: string) {
    return this.request("GET", `jobs/ingest/${jobId}`);
  }

  async bulkJobResults(jobId: string) {
    const params = new URLSearchParams({ isJobDone: "true", includeRetrieved: "true" });
    return this.request("GET", `jobs/ingest/${jobId}/results?${params}`, { accept: "text/csv", raw: true });
  }

  /** Bulk query job: create, poll status, then fetch CSV results by locator. */
  async createQueryJob(soql: string) {
    return this.request("POST", "jobs/query", {
      body: { operation: "query", query: soql, contentType: "CSV" },
    });
  }

  async queryJobResults(jobId: string, locator?: string) {
    const params = new URLSearchParams({ isJobDone: "true" });
    if (locator) params.set("locator", locator);
    return this.request("GET", `jobs/query/${jobId}/results?${params}`, { accept: "text/csv", raw: true });
  }
}

function client(): { sf: SfClient } | { error: string } {
  const stored = readToken("salesforce");
  if (!stored) {
    return {
      error:
        "Salesforce is not connected. Connect it in the Connectors panel with 'https://<org>.my.salesforce.com|<access_token>' or 'https://login.salesforce.com|<refresh_token>|<client_id>|<client_secret>'.",
    };
  }
  const cred = parseCredential(stored);
  if (!cred) return { error: "Salesforce credential is malformed. Expected 'instanceUrl|accessToken' or 'loginUrl|refreshToken|clientId|clientSecret'." };
  return { sf: new SfClient(cred) };
}

function wrap(e: unknown) {
  return { ok: false as const, error: safeErrorMessage(e, "Salesforce request failed") };
}

const fieldsSchema = z.record(z.string(), z.unknown()).describe("Field values, e.g. {\"Name\":\"Acme\",\"Industry\":\"Tech\"}");
const recordsSchema = z
  .array(z.record(z.string(), z.unknown()))
  .max(200)
  .describe("Up to 200 records, each holding field values (plus Id for updates)");

// Canonical tool registry: every native Salesforce tool the integration adds,
// with the Salesforce REST endpoint each wraps. The contract file
// salesforce.openapi.yaml must keep an operationId for every entry — pinned by
// scripts/check-salesforce-contract.mjs.
export const SF_TOOLS: { name: string; description: string; endpoint: string }[] = [
  { name: "soql_query", description: "SOQL with automatic queryMore pagination", endpoint: "GET /query, /queryAll" },
  { name: "sosl_search", description: "Cross-object text search", endpoint: "GET /search" },
  { name: "describe_global", description: "List all org objects", endpoint: "GET /sobjects" },
  { name: "describe_object", description: "Object fields and relationships", endpoint: "GET /sobjects/{type}/describe" },
  { name: "get_record", description: "Read one record by Id", endpoint: "GET /sobjects/{type}/{id}" },
  { name: "create_record", description: "Create one record", endpoint: "POST /sobjects/{type}" },
  { name: "update_record", description: "Patch one record", endpoint: "PATCH /sobjects/{type}/{id}" },
  { name: "upsert_record", description: "Create-or-update by external Id", endpoint: "PATCH /sobjects/{type}/{field}/{value}" },
  { name: "delete_record", description: "Delete one record", endpoint: "DELETE /sobjects/{type}/{id}" },
  { name: "create_records", description: "Create up to 200 records", endpoint: "POST /composite/sobjects" },
  { name: "update_records", description: "Update up to 200 records", endpoint: "PATCH /composite/sobjects" },
  { name: "get_records", description: "Read up to 200 records by Id", endpoint: "GET /composite/sobjects/{type}" },
  { name: "composite", description: "Ordered sub-requests with referenceId chaining", endpoint: "POST /composite" },
  { name: "bulk_ingest_create", description: "Open Bulk API 2.0 ingest job", endpoint: "POST /jobs/ingest" },
  { name: "bulk_ingest_upload", description: "Upload CSV batch and complete", endpoint: "PUT /jobs/ingest/{id}/batches" },
  { name: "bulk_ingest_status", description: "Job progress and counts", endpoint: "GET /jobs/ingest/{id}" },
  { name: "bulk_ingest_results", description: "Per-record success/failure CSV", endpoint: "GET /jobs/ingest/{id}/results" },
  { name: "bulk_query", description: "Create bulk query job", endpoint: "POST /jobs/query" },
  { name: "bulk_query_results", description: "Fetch bulk query CSV by locator", endpoint: "GET /jobs/query/{id}/results" },
  { name: "limits", description: "Org consumption vs limits", endpoint: "GET /limits" },
];

export function buildSalesforceTools(tenantArg = "default"): Record<string, Tool> {
  const tools: Record<string, Tool> = {};
  const tenant = tenantScope(tenantArg);
  // Only a connected org gets its schemas in the prompt (same rule as the SDK).
  if (!readToken("salesforce", tenant)) return tools;

  const t = (
    name: string,
    description: string,
    schema: z.ZodTypeAny,
    execute: (input: unknown) => Promise<unknown>,
  ) => {
    tools[`sf_${name}`] = tool({
      description: `Salesforce: ${description}`,
      inputSchema: schema,
      execute: (args: unknown) => runWithTenant(tenant, () => execute(args)),
    });
  };

  t(
    "soql_query",
    "Run a SOQL query. Automatically follows nextRecordsUrl for large result sets (set maxRecords, default 2000).",
    z.object({
      query: z.string().describe("SOQL, e.g. SELECT Id, Name, Amount FROM Opportunity WHERE StageName = 'Open' LIMIT 100"),
      queryAll: z.boolean().optional().describe("Include deleted/archived records (queryAll endpoint)"),
      maxRecords: z.number().int().min(1).max(100_000).optional().describe("Cap on fetched rows across pages (default 2000)"),
    }),
    async (i) => {
      const p = client();
      if ("error" in p) return p;
      const { query, queryAll, maxRecords } = i as { query: string; queryAll?: boolean; maxRecords?: number };
      try {
        const r = await p.sf.queryAll(query, { all: queryAll, maxRecords });
        return r.ok ? { ok: true, ...(r.data as Record<string, unknown>) } : { ok: false, error: extractSfError(r.data) ?? `HTTP ${r.status}`, status: r.status };
      } catch (e) {
        return wrap(e);
      }
    },
  );

  t(
    "sosl_search",
    "Text search across objects with SOSL.",
    z.object({
      query: z.string().describe("SOSL, e.g. FIND {Acme*} IN ALL FIELDS RETURNING Account(Id, Name), Contact(Id, Name)"),
    }),
    async (i) => {
      const p = client();
      if ("error" in p) return p;
      try {
        const r = await p.sf.request("GET", `search?q=${encodeURIComponent((i as { query: string }).query)}`);
        return r.ok ? { ok: true, data: r.data } : { ok: false, error: extractSfError(r.data) ?? `HTTP ${r.status}` };
      } catch (e) {
        return wrap(e);
      }
    },
  );

  t(
    "describe_global",
    "List every object in the org with its label, keyPrefix and queryable flag.",
    z.object({}),
    async () => {
      const p = client();
      if ("error" in p) return p;
      try {
        const r = await p.sf.request("GET", "sobjects");
        return r.ok
          ? { ok: true, sobjects: (r.data as { sobjects?: unknown }).sobjects }
          : { ok: false, error: extractSfError(r.data) ?? `HTTP ${r.status}` };
      } catch (e) {
        return wrap(e);
      }
    },
  );

  t(
    "describe_object",
    "Describe one object: every field (name, type, label, required, picklist values), child relationships and record type infos.",
    z.object({ sobject: z.string().describe("Object API name, e.g. Account, custom__c") }),
    async (i) => {
      const p = client();
      if ("error" in p) return p;
      try {
        const r = await p.sf.request("GET", `sobjects/${encodeURIComponent((i as { sobject: string }).sobject)}/describe`);
        return r.ok ? { ok: true, data: r.data } : { ok: false, error: extractSfError(r.data) ?? `HTTP ${r.status}` };
      } catch (e) {
        return wrap(e);
      }
    },
  );

  t(
    "get_record",
    "Read one record by Id (optionally projecting specific fields).",
    z.object({
      sobject: z.string(),
      id: z.string().describe("15- or 18-character record Id"),
      fields: z.array(z.string()).optional().describe("Field API names to return; omit for all fields"),
    }),
    async (i) => {
      const p = client();
      if ("error" in p) return p;
      const { sobject, id, fields } = i as { sobject: string; id: string; fields?: string[] };
      try {
        const q = fields?.length ? `?fields=${encodeURIComponent(fields.join(","))}` : "";
        const r = await p.sf.request("GET", `sobjects/${encodeURIComponent(sobject)}/${encodeURIComponent(id)}${q}`);
        return r.ok ? { ok: true, data: r.data } : { ok: false, error: extractSfError(r.data) ?? `HTTP ${r.status}` };
      } catch (e) {
        return wrap(e);
      }
    },
  );

  t(
    "create_record",
    "Create one record (REST sobjects endpoint).",
    z.object({ sobject: z.string(), fields: fieldsSchema }),
    async (i) => {
      const p = client();
      if ("error" in p) return p;
      const { sobject, fields } = i as { sobject: string; fields: Record<string, unknown> };
      try {
        const r = await p.sf.request("POST", `sobjects/${encodeURIComponent(sobject)}`, { body: fields });
        return r.ok ? { ok: true, data: r.data } : { ok: false, error: extractSfError(r.data) ?? `HTTP ${r.status}` };
      } catch (e) {
        return wrap(e);
      }
    },
  );

  t(
    "update_record",
    "Update one record by Id (PATCH; send only the fields to change).",
    z.object({ sobject: z.string(), id: z.string(), fields: fieldsSchema }),
    async (i) => {
      const p = client();
      if ("error" in p) return p;
      const { sobject, id, fields } = i as { sobject: string; id: string; fields: Record<string, unknown> };
      try {
        const r = await p.sf.request("PATCH", `sobjects/${encodeURIComponent(sobject)}/${encodeURIComponent(id)}`, { body: fields });
        return r.status === 204 ? { ok: true, id } : r.ok ? { ok: true, data: r.data } : { ok: false, error: extractSfError(r.data) ?? `HTTP ${r.status}` };
      } catch (e) {
        return wrap(e);
      }
    },
  );

  t(
    "upsert_record",
    "Create-or-update by external Id (PATCH /sobjects/{Type}/{field}/{value}).",
    z.object({
      sobject: z.string(),
      externalIdField: z.string().describe("External id field API name, e.g. External_Id__c (or 'Id')"),
      externalId: z.string().describe("The external id value"),
      fields: fieldsSchema,
    }),
    async (i) => {
      const p = client();
      if ("error" in p) return p;
      const { sobject, externalIdField, externalId, fields } = i as {
        sobject: string;
        externalIdField: string;
        externalId: string;
        fields: Record<string, unknown>;
      };
      try {
        const r = await p.sf.request(
          "PATCH",
          `sobjects/${encodeURIComponent(sobject)}/${encodeURIComponent(externalIdField)}/${encodeURIComponent(externalId)}`,
          { body: fields },
        );
        return r.ok ? { ok: true, data: r.data } : { ok: false, error: extractSfError(r.data) ?? `HTTP ${r.status}` };
      } catch (e) {
        return wrap(e);
      }
    },
  );

  t(
    "delete_record",
    "Delete one record by Id.",
    z.object({ sobject: z.string(), id: z.string() }),
    async (i) => {
      const p = client();
      if ("error" in p) return p;
      const { sobject, id } = i as { sobject: string; id: string };
      try {
        const r = await p.sf.request("DELETE", `sobjects/${encodeURIComponent(sobject)}/${encodeURIComponent(id)}`);
        return r.status === 204 ? { ok: true, id } : { ok: false, error: extractSfError(r.data) ?? `HTTP ${r.status}` };
      } catch (e) {
        return wrap(e);
      }
    },
  );

  const collectionAttrs = (sobject: string, records: Record<string, unknown>[]) =>
    records.map((f) => ({ attributes: { type: sobject }, ...f }));

  t(
    "create_records",
    "Create up to 200 records in one call (sObject Collections).",
    z.object({
      sobject: z.string(),
      records: recordsSchema,
      allOrNone: z.boolean().optional().describe("Roll back all on any failure (default false)"),
    }),
    async (i) => {
      const p = client();
      if ("error" in p) return p;
      const { sobject, records, allOrNone } = i as { sobject: string; records: Record<string, unknown>[]; allOrNone?: boolean };
      try {
        const r = await p.sf.request("POST", "composite/sobjects", {
          body: { records: collectionAttrs(sobject, records), allOrNone: allOrNone ?? false },
        });
        return r.ok ? { ok: true, data: r.data } : { ok: false, error: extractSfError(r.data) ?? `HTTP ${r.status}` };
      } catch (e) {
        return wrap(e);
      }
    },
  );

  t(
    "update_records",
    "Update up to 200 records in one call; each record needs its Id.",
    z.object({ sobject: z.string(), records: recordsSchema, allOrNone: z.boolean().optional() }),
    async (i) => {
      const p = client();
      if ("error" in p) return p;
      const { sobject, records, allOrNone } = i as { sobject: string; records: Record<string, unknown>[]; allOrNone?: boolean };
      try {
        const r = await p.sf.request("PATCH", "composite/sobjects", {
          body: { records: collectionAttrs(sobject, records), allOrNone: allOrNone ?? false },
        });
        return r.ok ? { ok: true, data: r.data } : { ok: false, error: extractSfError(r.data) ?? `HTTP ${r.status}` };
      } catch (e) {
        return wrap(e);
      }
    },
  );

  t(
    "get_records",
    "Read up to 200 records by Id list (sObject Collections).",
    z.object({
      sobject: z.string(),
      ids: z.array(z.string()).max(200).describe("Record Ids"),
      fields: z.array(z.string()).optional(),
    }),
    async (i) => {
      const p = client();
      if ("error" in p) return p;
      const { sobject, ids, fields } = i as { sobject: string; ids: string[]; fields?: string[] };
      try {
        const params = new URLSearchParams({ ids: ids.join(",") });
        if (fields?.length) params.set("fields", fields.join(","));
        const r = await p.sf.request("GET", `composite/sobjects/${encodeURIComponent(sobject)}?${params}`);
        return r.ok ? { ok: true, data: r.data } : { ok: false, error: extractSfError(r.data) ?? `HTTP ${r.status}` };
      } catch (e) {
        return wrap(e);
      }
    },
  );

  t(
    "composite",
    "Composite request: up to 25 sub-requests executed in order with allOrNone; reference earlier results with @{referenceId.Id}.",
    z.object({
      requests: z
        .array(
          z.object({
            method: z.enum(["GET", "POST", "PATCH", "DELETE"]),
            url: z.string().describe("Version-relative, e.g. sobjects/Account or sobjects/Account/@{accRef.Id}"),
            referenceId: z.string(),
            body: z.record(z.string(), z.unknown()).optional(),
          }),
        )
        .min(1)
        .max(25),
      allOrNone: z.boolean().optional(),
    }),
    async (i) => {
      const p = client();
      if ("error" in p) return p;
      const { requests, allOrNone } = i as {
        requests: { method: string; url: string; referenceId: string; body?: Record<string, unknown> }[];
        allOrNone?: boolean;
      };
      try {
        const r = await p.sf.request("POST", "composite", {
          body: {
            allOrNone: allOrNone ?? true,
            compositeRequest: requests.map((s) => ({
              method: s.method,
              url: s.url,
              referenceId: s.referenceId,
              ...(s.body ? { body: s.body } : {}),
            })),
          },
        });
        return r.ok ? { ok: true, data: r.data } : { ok: false, error: extractSfError(r.data) ?? `HTTP ${r.status}` };
      } catch (e) {
        return wrap(e);
      }
    },
  );

  t(
    "bulk_ingest_create",
    "Open a Bulk API 2.0 ingest job. Operations: insert, update, upsert (needs externalIdField), delete, hardDelete (needs Bulk Data Hard Delete permission).",
    z.object({
      operation: z.enum(["insert", "update", "upsert", "delete", "hardDelete"]),
      sobject: z.string(),
      externalIdField: z.string().optional().describe("Required for upsert"),
      assignmentRuleId: z.string().optional().describe("Assignment rule for Case/Lead ingests"),
    }),
    async (i) => {
      const p = client();
      if ("error" in p) return p;
      const job = i as { operation: string; sobject: string; externalIdField?: string; assignmentRuleId?: string };
      try {
        const r = await p.sf.createIngestJob(job);
        return r.ok ? { ok: true, job: r.data } : { ok: false, error: extractSfError(r.data) ?? `HTTP ${r.status}` };
      } catch (e) {
        return wrap(e);
      }
    },
  );

  t(
    "bulk_ingest_upload",
    "Upload CSV data into an ingest job. Header row = field API names. Completes the upload (state becomes UploadComplete) unless complete=false.",
    z.object({
      jobId: z.string().describe("Job Id from bulk_ingest_create"),
      csv: z.string().describe("CSV body, e.g. Name,Industry\\r\\nAcme,Tech\\r\\n"),
      complete: z.boolean().optional(),
    }),
    async (i) => {
      const p = client();
      if ("error" in p) return p;
      const { jobId, csv, complete } = i as { jobId: string; csv: string; complete?: boolean };
      try {
        const up = await p.sf.uploadIngestBatch(jobId, csv);
        if (!up.ok) return { ok: false, error: extractSfError(up.data) ?? `HTTP ${up.status}` };
        if (complete === false) return { ok: true, uploaded: true };
        const closed = await p.sf.closeIngestJob(jobId);
        return closed.ok
          ? { ok: true, uploaded: true, job: closed.data }
          : { ok: false, error: extractSfError(closed.data) ?? `HTTP ${closed.status}` };
      } catch (e) {
        return wrap(e);
      }
    },
  );

  t(
    "bulk_ingest_status",
    "Check an ingest job: processed counts, failures and state.",
    z.object({ jobId: z.string() }),
    async (i) => {
      const p = client();
      if ("error" in p) return p;
      try {
        const r = await p.sf.bulkJobStatus((i as { jobId: string }).jobId);
        return r.ok ? { ok: true, job: r.data } : { ok: false, error: extractSfError(r.data) ?? `HTTP ${r.status}` };
      } catch (e) {
        return wrap(e);
      }
    },
  );

  t(
    "bulk_ingest_results",
    "Fetch per-record results (CSV) for a finished ingest job.",
    z.object({ jobId: z.string() }),
    async (i) => {
      const p = client();
      if ("error" in p) return p;
      try {
        const r = await p.sf.bulkJobResults((i as { jobId: string }).jobId);
        return r.ok ? { ok: true, csv: String(r.data) } : { ok: false, error: extractSfError(r.data) ?? `HTTP ${r.status}` };
      } catch (e) {
        return wrap(e);
      }
    },
  );

  t(
    "bulk_query",
    "Bulk query a large data volume: creates a query job and returns its Id; fetch CSV with bulk_query_results.",
    z.object({ query: z.string().describe("SOQL for the Bulk API (no aggregate functions)") }),
    async (i) => {
      const p = client();
      if ("error" in p) return p;
      try {
        const r = await p.sf.createQueryJob((i as { query: string }).query);
        return r.ok
          ? { ok: true, job: r.data, next: "poll bulk_query_results until the job is done, then read the CSV" }
          : { ok: false, error: extractSfError(r.data) ?? `HTTP ${r.status}` };
      } catch (e) {
        return wrap(e);
      }
    },
  );

  t(
    "bulk_query_results",
    "Fetch CSV results of a bulk query job (pass locator for the next page when one is reported).",
    z.object({ jobId: z.string(), locator: z.string().optional() }),
    async (i) => {
      const p = client();
      if ("error" in p) return p;
      const { jobId, locator } = i as { jobId: string; locator?: string };
      try {
        const r = await p.sf.queryJobResults(jobId, locator);
        return r.ok ? { ok: true, csv: String(r.data) } : { ok: false, error: extractSfError(r.data) ?? `HTTP ${r.status}` };
      } catch (e) {
        return wrap(e);
      }
    },
  );

  t(
    "limits",
    "Current org limits: daily API requests, Bulk API, concurrent limits and more, with what is already consumed.",
    z.object({}),
    async () => {
      const p = client();
      if ("error" in p) return p;
      try {
        const r = await p.sf.request("GET", "limits");
        return r.ok ? { ok: true, data: r.data } : { ok: false, error: extractSfError(r.data) ?? `HTTP ${r.status}` };
      } catch (e) {
        return wrap(e);
      }
    },
  );

  return tools;
}
