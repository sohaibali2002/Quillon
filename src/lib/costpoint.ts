// Deep native Deltek Costpoint integration, built against the official
// Costpoint 8.1 Developer Resources (https://help.deltek.com/product/costpoint/
// documentation/Costpoint_81_Developer_Resources.html). Goes beyond the generic
// connector SDK: OData v4 queries with automatic paging, record CRUD on any
// Costpoint entity, batch upserts, the $metadata catalog, labor actual entry,
// and one-call project / AP voucher snapshots that chain multiple queries.
//
// Auth: Costpoint Cloud deployments use OAuth 2.0 (password grant with a
// registered API client), so the costpoint connector stores
// 'baseUrl|clientId|clientSecret|username|password' in its token field.
// On-prem deployments that issue a static API key can store
// 'baseUrl|apiKey' instead; the key is sent as the X-Api-Key header.
// The service root defaults to {baseUrl}/api/v1 (OData v4: $filter/$select/
// $top/$skip, ({key}) addressing, If-Match ETags, $metadata).
import { tool, type Tool } from "ai";
import { z } from "zod";
import { readToken } from "./connectors";
import { runWithTenant, tenantScope } from "./tenant-context";
import { safeErrorMessage } from "./sanitize";

export interface CostpointCred {
  baseUrl: string;
  apiKey?: string;
  clientId?: string;
  clientSecret?: string;
  username?: string;
  password?: string;
}

/** Accepts the OAuth2 form (5 parts) or the static API-key form (2 parts). */
export function parseCostpointCredential(stored: string): CostpointCred | null {
  const parts = stored.split("|");
  if (parts.length === 2 && parts.every(Boolean)) {
    return { baseUrl: parts[0], apiKey: parts[1] };
  }
  if (parts.length === 5 && parts.every(Boolean)) {
    const [baseUrl, clientId, clientSecret, username, password] = parts;
    return { baseUrl, clientId, clientSecret, username, password };
  }
  return null;
}

export function normalizeBaseUrl(url: string): string {
  return url.replace(/\/+$/, "");
}

export function serviceRootOf(baseUrl: string): string {
  return `${normalizeBaseUrl(baseUrl)}/api/v1`;
}

/** OData key literal: strings need quotes, numbers do not. */
export function keyLiteral(key: string | number): string {
  const s = String(key);
  return /^-?\d+(\.\d+)?$/.test(s) ? s : `'${s.replace(/'/g, "''")}'`;
}

export function keyPath(entity: string, key: string | number): string {
  return `${entity}(${keyLiteral(key)})`;
}

/** Costpoint/OData error bodies: {error:{code, message}} where message is
 *  either a string or {lang, value}. */
export function extractCostpointError(data: unknown): string | null {
  const err = (data as { error?: { code?: unknown; message?: unknown } } | null)?.error;
  if (!err) return null;
  const message =
    typeof err.message === "string"
      ? err.message
      : err.message && typeof err.message === "object"
        ? String((err.message as { value?: unknown }).value ?? "")
        : "";
  return [err.code, message].filter(Boolean).join(": ") || null;
}

interface TokenCache {
  token: string;
  expiresAt: number;
}

export class CostpointClient {
  private cred: CostpointCred;
  private token: TokenCache | null = null;

  constructor(cred: CostpointCred) {
    this.cred = cred;
  }

  get baseUrl(): string {
    return normalizeBaseUrl(this.cred.baseUrl);
  }

  get root(): string {
    return serviceRootOf(this.baseUrl);
  }

  /** OAuth2 password grant. Access tokens are cached until 60s before expiry. */
  async accessToken(force = false): Promise<string | null> {
    if (this.cred.apiKey) return null; // API-key mode signs with a header instead
    if (!force && this.token && Date.now() < this.token.expiresAt) return this.token.token;
    const res = await fetch(`${this.baseUrl}/api/oauth2/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams({
        grant_type: "password",
        client_id: this.cred.clientId ?? "",
        client_secret: this.cred.clientSecret ?? "",
        username: this.cred.username ?? "",
        password: this.cred.password ?? "",
      }),
      signal: AbortSignal.timeout(30_000),
    });
    const data: unknown = await res.json().catch(() => ({}));
    const d = data as { access_token?: string; expires_in?: number; error_description?: string };
    if (!res.ok || !d.access_token) {
      throw new Error(`Costpoint token request failed: ${d.error_description ?? res.status}`);
    }
    const ttl = typeof d.expires_in === "number" ? d.expires_in : 3600;
    this.token = { token: d.access_token, expiresAt: Date.now() + Math.max(60, ttl - 60) * 1000 };
    return this.token.token;
  }

  headers(token: string | null, extra?: Record<string, string>): Record<string, string> {
    const h: Record<string, string> = { accept: "application/json", ...extra };
    if (this.cred.apiKey) h["x-api-key"] = this.cred.apiKey;
    else if (token) h.authorization = `Bearer ${token}`;
    return h;
  }

  /** One API call. A 401 drops the cached token and retries once (expired
   *  access token); 429/502/503 retry once honoring Retry-After. */
  async request(
    method: string,
    servicePath: string,
    init?: {
      body?: unknown;
      query?: Record<string, string | number | undefined>;
      accept?: string;
      headers?: Record<string, string>;
      retry?: number;
    },
  ): Promise<{ status: number; ok: boolean; data: unknown; etag?: string | null }> {
    const token = await this.accessToken().catch(() => null);
    const url = new URL(`${this.root}/${servicePath.replace(/^\/+/, "")}`);
    for (const [k, v] of Object.entries(init?.query ?? {})) if (v !== undefined) url.searchParams.set(k, String(v));

    const headers = this.headers(token, {
      ...(init?.body !== undefined ? { "content-type": "application/json" } : {}),
      ...(init?.accept ? { accept: init.accept } : {}),
      ...init?.headers,
    });
    const res = await fetch(url, {
      method,
      headers,
      body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
      signal: AbortSignal.timeout(60_000),
    });
    const raw = await res.text();
    let data: unknown = null;
    if (raw) {
      try {
        data = JSON.parse(raw);
      } catch {
        data = raw; // non-JSON bodies (EDMX $metadata XML) pass through as text
      }
    }

    if (res.status === 401 && !this.cred.apiKey && (init?.retry ?? 0) < 1) {
      await this.accessToken(true);
      return this.request(method, servicePath, { ...init, retry: 1 });
    }
    const limited = res.status === 429 || res.status === 502 || res.status === 503;
    if (limited && (init?.retry ?? 0) < 1) {
      const after = Number(res.headers.get("retry-after") ?? "1");
      await new Promise((r) => setTimeout(r, Math.min(5000, Number.isFinite(after) && after > 0 ? after * 1000 : 1000)));
      return this.request(method, servicePath, { ...init, retry: 1 });
    }
    return { status: res.status, ok: res.ok, data, etag: res.headers.get("etag") };
  }

  /** OData collection query with automatic $skip paging; capped at 10,000 rows. */
  async query(
    entity: string,
    opts: { filter?: string; select?: string; orderBy?: string; maxRows?: number },
  ) {
    const cap = Math.min(10_000, Math.max(1, opts.maxRows ?? 1000));
    const items: unknown[] = [];
    let skip = 0;
    for (let page = 0; page < 200; page++) {
      const r = await this.request("GET", entity, {
        query: {
          $filter: opts.filter,
          $select: opts.select,
          $orderby: opts.orderBy,
          $top: 200,
          $skip: skip,
        },
      });
      if (!r.ok) return r;
      const d = r.data as { value?: unknown[] };
      const pageItems = Array.isArray(d.value) ? d.value : [];
      items.push(...pageItems);
      if (pageItems.length < 200 || items.length >= cap) break;
      skip += pageItems.length;
    }
    return {
      status: 200,
      ok: true,
      data: { value: items.slice(0, cap), fetched: items.length, truncated: items.length >= cap },
    };
  }

  /** Read one record, carrying the ETag back for conditional writes. */
  async getRecord(entity: string, key: string | number) {
    return this.request("GET", keyPath(entity, key));
  }
}

function client(): { cp: CostpointClient } | { error: string } {
  const stored = readToken("costpoint");
  if (!stored) {
    return {
      error:
        "Costpoint is not connected. Add a credential for the costpoint connector: 'baseUrl|clientId|clientSecret|username|password' (OAuth2) or 'baseUrl|apiKey' (static API key).",
    };
  }
  const cred = parseCostpointCredential(stored);
  if (!cred)
    return {
      error:
        "Costpoint credential is malformed. Expected 'baseUrl|clientId|clientSecret|username|password' or 'baseUrl|apiKey'.",
    };
  return { cp: new CostpointClient(cred) };
}

function wrap(e: unknown) {
  return { ok: false as const, error: safeErrorMessage(e, "Costpoint request failed") };
}

/** Patches one record only against its **live** ETag. The record is re-read
 *  immediately before the write, so a change that landed between a model's
 *  earlier read and this write comes back as 412 instead of being overwritten,
 *  and `If-Match: *` (unconditional write) is never sent. */
export async function patchRecordGuarded(
  cp: CostpointClient,
  entityName: string,
  key: string | number,
  fields: Record<string, unknown>,
): Promise<{ ok: boolean; error?: string }> {
  const live = await cp.request("GET", keyPath(entityName, key));
  if (!live.ok) return { ok: false, error: extractCostpointError(live.data) ?? `HTTP ${live.status}` };
  const ifMatch = live.etag;
  if (!ifMatch || ifMatch === "*") {
    return { ok: false, error: "No ETag available; unconditional updates are refused." };
  }
  const r = await cp.request("PATCH", keyPath(entityName, key), {
    body: fields,
    headers: { "if-match": ifMatch },
  });
  return r.ok ? { ok: true } : { ok: false, error: extractCostpointError(r.data) ?? `HTTP ${r.status}` };
}

/** Deletes one record only against a real ETag — supplied by the caller, or
 *  read fresh here. Wildcard deletes and deletes with no ETag are refused. */
export async function deleteRecordGuarded(
  cp: CostpointClient,
  entityName: string,
  key: string | number,
  etag?: string,
): Promise<{ ok: boolean; error?: string }> {
  if (etag === "*") return { ok: false, error: "Wildcard If-Match is not allowed for deletes." };
  let ifMatch = etag;
  if (!ifMatch) {
    const live = await cp.request("GET", keyPath(entityName, key));
    if (!live.ok) return { ok: false, error: extractCostpointError(live.data) ?? `HTTP ${live.status}` };
    ifMatch = live.etag ?? undefined;
  }
  if (!ifMatch || ifMatch === "*") {
    return {
      ok: false,
      error: "No ETag available for this record, so an unconditional delete is refused. Re-read the record and retry.",
    };
  }
  const r = await cp.request("DELETE", keyPath(entityName, key), { headers: { "if-match": ifMatch } });
  return r.ok ? { ok: true } : { ok: false, error: extractCostpointError(r.data) ?? `HTTP ${r.status}` };
}

const entity = z
  .string()
  .describe(
    "Costpoint entity (table) name, e.g. PROJECT, ORGANIZATION, EMPE (employees), VOUCHER_HDR, VOUCHER_DETL, PO_HDR, CUSTOMER, LABOR_ACTUALS. See the metadata tool for the full catalog.",
  );
const key = z
  .union([z.string(), z.number()])
  .describe("Primary key value, e.g. the project ID 'P24-1001' or employee ID 1234");
const fieldsSchema = z
  .record(z.string(), z.unknown())
  .describe('Entity fields in Costpoint JSON shape, e.g. {"PROJECT_ID":"P24-1001","DESCRIPTION":"Phase 1"}');

// Canonical tool registry: contract operations in costpoint.openapi.yaml must
// match these names exactly (pinned by scripts/check-costpoint-contract.mjs).
export const CP_TOOLS: { name: string; description: string; endpoint: string }[] = [
  { name: "query", description: "OData query on any entity with automatic $skip paging", endpoint: "GET /{entity}?$filter&$select&$orderby&$top&$skip" },
  { name: "get_record", description: "Read one record by key, returning its ETag", endpoint: "GET /{entity}({key})" },
  { name: "create_record", description: "Create one record", endpoint: "POST /{entity}" },
  { name: "update_record", description: "Patch one record (If-Match ETag)", endpoint: "PATCH /{entity}({key})" },
  { name: "delete_record", description: "Delete one record (If-Match ETag)", endpoint: "DELETE /{entity}({key})" },
  { name: "batch_upsert", description: "Update or create up to 100 records, per-record results", endpoint: "PATCH /{entity}({key}) xN" },
  { name: "metadata", description: "Entity metadata catalog: properties, keys, types", endpoint: "GET /$metadata" },
  { name: "labor_entries", description: "Post labor actual lines (employee, project, WBS, period, hours)", endpoint: "POST /LABOR_ACTUALS" },
  { name: "project_snapshot", description: "One-call project view: header + budget lines + organization", endpoint: "GET /PROJECT({key}) + chained queries" },
  { name: "voucher_snapshot", description: "One-call AP voucher view: header + detail lines + vendor", endpoint: "GET /VOUCHER_HDR({key}) + chained queries" },
];

export function buildCostpointTools(tenantArg = "default"): Record<string, Tool> {
  const tools: Record<string, Tool> = {};
  const tenant = tenantScope(tenantArg);
  // Only a connected account gets its schemas in the prompt (same rule as the SDK).
  if (!readToken("costpoint", tenant)) return tools;

  const t = (name: string, description: string, schema: z.ZodTypeAny, execute: (input: unknown) => Promise<unknown>) => {
    tools[`cp_${name}`] = tool({
      description: `Costpoint: ${description}`,
      inputSchema: schema,
      execute: (args: unknown) => runWithTenant(tenant, () => execute(args)),
    });
  };

  const fetchErr = (r: { status: number; data: unknown }) => extractCostpointError(r.data) ?? `HTTP ${r.status}`;

  t(
    "query",
    "Query any Costpoint entity with an OData $filter (e.g. \"PROJECT_ID eq 'P24-1001'\" or \"STATUS eq 'A' and START_DATE ge 2024-01-01\"). Follows $skip paging up to maxRows.",
    z.object({
      entity,
      filter: z.string().optional().describe('OData filter, e.g. "STATUS eq \'A\'"'),
      select: z.string().optional().describe("Comma-separated property list"),
      orderBy: z.string().optional().describe("e.g. PROJECT_ID desc"),
      maxRows: z.number().int().min(1).max(10_000).optional().describe("Cap across pages (default 1000)"),
    }),
    async (i) => {
      const p = client();
      if ("error" in p) return p;
      const o = i as { entity: string; filter?: string; select?: string; orderBy?: string; maxRows?: number };
      try {
        const r = await p.cp.query(o.entity, o);
        return r.ok ? r.data : { ok: false, error: fetchErr(r) };
      } catch (e) {
        return wrap(e);
      }
    },
  );

  t(
    "get_record",
    "Read one record by primary key and return it with its ETag (for later update/delete).",
    z.object({ entity, key }),
    async (i) => {
      const p = client();
      if ("error" in p) return p;
      const { entity: e, key: k } = i as { entity: string; key: string | number };
      try {
        const r = await p.cp.getRecord(e, k);
        return r.ok ? { ...(r.data as Record<string, unknown>), etag: r.etag } : { ok: false, error: fetchErr(r) };
      } catch (e2) {
        return wrap(e2);
      }
    },
  );

  t(
    "create_record",
    "Create one record on an entity.",
    z.object({ entity, fields: fieldsSchema }),
    async (i) => {
      const p = client();
      if ("error" in p) return p;
      const { entity: e, fields } = i as { entity: string; fields: Record<string, unknown> };
      try {
        const r = await p.cp.request("POST", e, { body: fields });
        return r.ok ? r.data : { ok: false, error: fetchErr(r) };
      } catch (e2) {
        return wrap(e2);
      }
    },
  );

  t(
    "update_record",
    "Patch one record by key. The ETag from a prior get_record is required: a wildcard write would overwrite changes made since the read.",
    z.object({
      entity,
      key,
      fields: fieldsSchema,
      etag: z.string().min(1).describe("ETag from a prior get_record; sent as If-Match"),
    }),
    async (i) => {
      const p = client();
      if ("error" in p) return p;
      const { entity: e, key: k, fields, etag } = i as {
        entity: string;
        key: string | number;
        fields: Record<string, unknown>;
        etag: string;
      };
      if (!etag || etag === "*") {
        return { ok: false, error: "An ETag from a prior get_record is required for updates; wildcard writes are not allowed." };
      }
      try {
        const r = await p.cp.request("PATCH", keyPath(e, k), {
          body: fields,
          headers: { "if-match": etag },
        });
        return r.ok ? { ok: true, key: k } : { ok: false, error: fetchErr(r) };
      } catch (e2) {
        return wrap(e2);
      }
    },
  );

  t(
    "delete_record",
    "Delete one record by key. Always sends the current If-Match ETag: the record is read first (or an explicit etag is supplied) so a concurrent edit can never be deleted blindly.",
    z.object({
      entity,
      key,
      etag: z.string().optional().describe("Optional ETag from get_record; read fresh when omitted"),
    }),
    async (i) => {
      const p = client();
      if ("error" in p) return p;
      const { entity: e, key: k, etag } = i as { entity: string; key: string | number; etag?: string };
      try {
        const r = await deleteRecordGuarded(p.cp, e, k, etag);
        return r.ok ? { ok: true, key: k } : { ok: false, error: r.error ?? "delete failed" };
      } catch (e2) {
        return wrap(e2);
      }
    },
  );

  t(
    "batch_upsert",
    "Apply up to 100 patches in sequence: each item updates an existing key. Per-record results; one failure never stops the batch.",
    z.object({
      entity,
      records: z
        .array(z.object({ key, fields: fieldsSchema }))
        .min(1)
        .max(100)
        .describe("Per-record key + fields"),
    }),
    async (i) => {
      const p = client();
      if ("error" in p) return p;
      const { entity: e, records } = i as {
        entity: string;
        records: { key: string | number; fields: Record<string, unknown> }[];
      };
      const results: { key: string; ok: boolean; error?: string }[] = [];
      for (const rec of records) {
        try {
          // Read the live ETag first: a batch patch without If-Match silently
          // overwrites whatever landed between the read and the write.
          const r = await patchRecordGuarded(p.cp, e, rec.key, rec.fields);
          results.push({ key: String(rec.key), ok: r.ok, error: r.error });
        } catch (e2) {
          results.push({ key: String(rec.key), ok: false, error: safeErrorMessage(e2, "failed") });
        }
      }
      return {
        ok: results.every((x) => x.ok),
        results,
        total: results.length,
        failed: results.filter((x) => !x.ok).length,
      };
    },
  );

  t(
    "metadata",
    "Read the OData $metadata catalog (optionally for one entity): properties, key fields and types. Use it to discover valid entity and field names.",
    z.object({ entity: entity.optional() }),
    async (i) => {
      const p = client();
      if ("error" in p) return p;
      const { entity: e } = i as { entity?: string };
      try {
        const r = await p.cp.request("GET", e ? `$metadata#${e}` : "$metadata", { accept: "application/xml" });
        return r.ok
          ? { ok: true, xml: typeof r.data === "string" ? r.data : JSON.stringify(r.data) }
          : { ok: false, error: fetchErr(r) };
      } catch (e2) {
        return wrap(e2);
      }
    },
  );

  t(
    "labor_entries",
    "Post labor actual lines: one entry per employee/project/WBS/day with hours and charge code. Written to the LABOR_ACTUALS entity for timesheet import.",
    z.object({
      entries: z
        .array(
          z.object({
            employeeId: z.union([z.string(), z.number()]).describe("Costpoint employee ID (EMPE)"),
            projectId: z.string().describe("Project/WBS1 charge code"),
            wbs2: z.string().optional(),
            wbs3: z.string().optional(),
            workDate: z.string().describe("Work date, YYYY-MM-DD"),
            hours: z.number().positive(),
            timesheetPeriod: z.string().optional().describe("Pay period code, e.g. 2024-14"),
          }),
        )
        .min(1)
        .max(200),
    }),
    async (i) => {
      const p = client();
      if ("error" in p) return p;
      const { entries } = i as {
        entries: {
          employeeId: string | number;
          projectId: string;
          wbs2?: string;
          wbs3?: string;
          workDate: string;
          hours: number;
          timesheetPeriod?: string;
        }[];
      };
      const body = entries.map((x) => ({
        EMPE_ID: String(x.employeeId),
        PROJECT_ID: x.projectId,
        ...(x.wbs2 ? { WBS2_ID: x.wbs2 } : {}),
        ...(x.wbs3 ? { WBS3_ID: x.wbs3 } : {}),
        WORK_DT: x.workDate,
        HOURS: x.hours,
        ...(x.timesheetPeriod ? { TS_PERIOD: x.timesheetPeriod } : {}),
      }));
      const results: { index: number; ok: boolean; error?: string }[] = [];
      for (let n = 0; n < body.length; n++) {
        try {
          const r = await p.cp.request("POST", "LABOR_ACTUALS", { body: body[n] });
          results.push({ index: n, ok: r.ok, error: r.ok ? undefined : fetchErr(r) });
        } catch (e2) {
          results.push({ index: n, ok: false, error: e2 instanceof Error ? e2.message : "failed" });
        }
      }
      return {
        ok: results.every((x) => x.ok),
        results,
        posted: results.filter((x) => x.ok).length,
        failed: results.filter((x) => !x.ok).length,
      };
    },
  );

  t(
    "project_snapshot",
    "One-call project view: the project header, its budget lines (PROJECT_BUDGETS), and its owning organization. Chains three queries so the model gets full context in one tool call.",
    z.object({ projectId: z.string().describe("Project ID, e.g. P24-1001") }),
    async (i) => {
      const p = client();
      if ("error" in p) return p;
      const { projectId } = i as { projectId: string };
      try {
        const head = await p.cp.getRecord("PROJECT", projectId);
        if (!head.ok) return { ok: false, error: fetchErr(head) };
        const q = projectId.replace(/'/g, "''");
        const budgets = await p.cp.query("PROJECT_BUDGETS", { filter: `PROJECT_ID eq '${q}'`, maxRows: 500 });
        const org = await p.cp.query("ORGANIZATION", {
          filter: `ORG_ID eq '${String((head.data as { ORG_ID?: string })?.ORG_ID ?? "").replace(/'/g, "''")}'`,
          maxRows: 1,
        });
        return {
          ok: true,
          project: head.data,
          etag: head.etag,
          budgets: budgets.ok ? (budgets.data as { value: unknown[] }).value : null,
          organization: org.ok ? ((org.data as { value: unknown[] }).value[0] ?? null) : null,
        };
      } catch (e) {
        return wrap(e);
      }
    },
  );

  t(
    "voucher_snapshot",
    "One-call AP voucher view: the voucher header, its detail lines, and the vendor record. Chains three queries in one tool call.",
    z.object({ voucherId: z.union([z.string(), z.number()]).describe("Voucher header key (VOUCHER_HDR)") }),
    async (i) => {
      const p = client();
      if ("error" in p) return p;
      const { voucherId } = i as { voucherId: string | number };
      try {
        const head = await p.cp.getRecord("VOUCHER_HDR", voucherId);
        if (!head.ok) return { ok: false, error: fetchErr(head) };
        const h = head.data as { VOUCHER_ID?: string; VENDOR_ID?: string };
        const lines = await p.cp.query("VOUCHER_DETL", {
          filter: `VOUCHER_ID eq '${String(h?.VOUCHER_ID ?? voucherId).replace(/'/g, "''")}'`,
          maxRows: 500,
        });
        const vendor = h?.VENDOR_ID ? await p.cp.getRecord("VENDOR", h.VENDOR_ID) : null;
        return {
          ok: true,
          voucher: head.data,
          etag: head.etag,
          lines: lines.ok ? (lines.data as { value: unknown[] }).value : null,
          vendor: vendor && vendor.ok ? vendor.data : null,
        };
      } catch (e) {
        return wrap(e);
      }
    },
  );

  return tools;
}
