// Deep native NetSuite integration, built against the official SuiteTalk REST
// Web Services docs (https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help).
// Goes beyond the generic connector SDK: SuiteQL with automatic offset paging,
// record CRUD against any REST record type, create-or-update by external ID
// (PUT), external-ID addressing (eid:), record transforms (salesOrder ->
// invoice), sublist reads, the record metadata catalog, and error surfaces in
// NetSuite's own o:errorCode shape.
//
// Auth: Token-Based Authentication (OAuth 1.0, HMAC-SHA256 — HMAC-SHA1 support
// ended with NetSuite 2023.1). NetSuite's account-specific domain
// (<accountId>.suitetalk.api.netsuite.com) needs the raw account ID, so the
// netsuite connector stores
// 'accountId|consumerKey|consumerSecret|tokenId|tokenSecret' in its token field.
import { createHmac, randomUUID } from "node:crypto";
import { tool, type Tool } from "ai";
import { z } from "zod";
import { readToken } from "./connectors";

const HOST_SUFFIX = ".suitetalk.api.netsuite.com";

export interface NetSuiteCred {
  accountId: string;
  consumerKey: string;
  consumerSecret: string;
  tokenId: string;
  tokenSecret: string;
}

/** RFC 5849 percent encoding — encodeURIComponent leaves !'()* unescaped. */
export function pct(s: string): string {
  return encodeURIComponent(s).replace(/[!'()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());
}

/** OAuth 1.0 realm: sandbox accounts '123456-sb1' become '123456_SB1'. */
export function realmOf(accountId: string): string {
  return accountId.replace(/-/g, "_").toUpperCase();
}

export function parseNetSuiteCredential(stored: string): NetSuiteCred | null {
  const parts = stored.split("|");
  if (parts.length !== 5 || parts.some((p) => !p)) return null;
  const [accountId, consumerKey, consumerSecret, tokenId, tokenSecret] = parts;
  return { accountId, consumerKey, consumerSecret, tokenId, tokenSecret };
}

export class NetSuiteClient {
  private cred: NetSuiteCred;

  constructor(cred: NetSuiteCred) {
    this.cred = cred;
  }

  get host(): string {
    return `${this.cred.accountId}${HOST_SUFFIX}`;
  }

  /** Signed Authorization header. realm carries the account ID (uppercased,
   *  hyphens to underscores); only the six oauth_* params enter the signature
   *  base — realm itself is not signed. */
  authorizationHeader(method: string, url: string, timestamp: string, nonce: string): string {
    const { consumerKey, consumerSecret, tokenId, tokenSecret } = this.cred;
    const oauth: Record<string, string> = {
      oauth_consumer_key: consumerKey,
      oauth_nonce: nonce,
      oauth_signature_method: "HMAC-SHA256",
      oauth_timestamp: timestamp,
      oauth_token: tokenId,
      oauth_version: "1.0",
    };
    // Base string params = query params + oauth params, sorted, RFC 3986 encoded.
    const u = new URL(url);
    const params: [string, string][] = [
      ...Array.from(u.searchParams.entries()),
      ...Object.entries(oauth),
    ];
    const encoded = params
      .map(([k, v]) => [pct(k), pct(v)] as [string, string])
      .sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : 1) : a[0] < b[0] ? -1 : 1))
      .map(([k, v]) => `${k}=${v}`)
      .join("&");
    const base = [method.toUpperCase(), pct(u.origin + u.pathname), pct(encoded)].join("&");
    const signature = createHmac("sha256", `${consumerSecret}&${tokenSecret}`).update(base).digest("base64");
    const pairs = Object.entries({ ...oauth, oauth_signature: signature }).map(
      ([k, v]) => `${k}="${pct(v)}"`,
    );
    return `OAuth realm="${realmOf(this.cred.accountId)}", ${pairs.join(", ")}`;
  }

  /** One signed API call. NetSuite reports errors as non-2xx with an nsError
   *  body ({type, title, status, o:errorCode, o:errorDetails}); request-burst
   *  and concurrency limits surface as 429/502/503, retried once. */
  async request(
    method: string,
    servicePath: string,
    init?: {
      body?: unknown;
      query?: Record<string, string | number | undefined>;
      accept?: string;
      retry?: number;
    },
  ): Promise<{ status: number; ok: boolean; data: unknown; location?: string | null }> {
    const url = new URL(`https://${this.host}/services/rest/${servicePath.replace(/^\/+/, "")}`);
    for (const [k, v] of Object.entries(init?.query ?? {})) if (v !== undefined) url.searchParams.set(k, String(v));

    const timestamp = Math.floor(Date.now() / 1000).toString();
    const nonce = `${randomUUID()}${randomUUID()}`.replace(/-/g, "").slice(0, 32);
    const headers: Record<string, string> = {
      accept: init?.accept ?? "application/json",
      authorization: this.authorizationHeader(method, url.toString(), timestamp, nonce),
    };
    if (init?.body !== undefined) headers["content-type"] = "application/json";
    const res = await fetch(url, {
      method,
      headers,
      body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
      signal: AbortSignal.timeout(60_000),
    });
    const data: unknown = res.status === 204 ? null : await res.json().catch(() => ({}));
    const limited = res.status === 429 || res.status === 502 || res.status === 503;
    if (limited && (init?.retry ?? 0) < 1) {
      const after = Number(res.headers.get("retry-after") ?? "1");
      await new Promise((r) => setTimeout(r, Math.min(5000, Number.isFinite(after) && after > 0 ? after * 1000 : 1000)));
      return this.request(method, servicePath, { ...init, retry: 1 });
    }
    return { status: res.status, ok: res.ok, data, location: res.headers.get("location") };
  }

  /** SuiteQL with full offset paging. NetSuite caps one query execution at
   *  100,000 rows and one page at limit <= 100; we cap maxRows at 10,000 to
   *  keep tool outputs bounded. */
  async suiteQL(q: string, maxRows = 1000) {
    const cap = Math.min(10_000, Math.max(1, maxRows));
    const items: unknown[] = [];
    let offset = 0;
    for (let page = 0; page < 200; page++) {
      const r = await this.request("POST", "query/v1/suiteql", {
        body: { q },
        query: { limit: 100, offset },
      });
      if (!r.ok) return r;
      const d = r.data as { items?: unknown[]; hasMore?: boolean };
      const pageItems = Array.isArray(d.items) ? d.items : [];
      items.push(...pageItems);
      if (!d.hasMore || pageItems.length === 0 || items.length >= cap) break;
      offset += pageItems.length;
    }
    return { status: 200, ok: true, data: { items, fetched: items.length, truncated: items.length >= cap } };
  }
}

/** NetSuite REST error bodies:
 *  {type, title, status, detail, o:errorCode, o:errorDetails:[{detail, o:errorCode, o:errorPath}], o:correlationId} */
export function extractNsError(data: unknown): string | null {
  if (data && typeof data === "object" && (data as { title?: unknown }).title !== undefined) {
    const d = data as {
      title?: string;
      detail?: string;
      "o:errorCode"?: string;
      "o:errorDetails"?: { detail?: string; "o:errorCode"?: string }[];
    };
    const extras = d["o:errorDetails"]
      ?.map((e) => [e["o:errorCode"], e.detail].filter(Boolean).join(": "))
      .filter(Boolean);
    return [d["o:errorCode"], d.detail ?? d.title, extras?.length ? extras.join("; ") : null].filter(Boolean).join(": ");
  }
  return null;
}

function client(): { ns: NetSuiteClient } | { error: string } {
  const stored = readToken("netsuite");
  if (!stored) {
    return {
      error:
        "NetSuite is not connected. Add a Token-Based Authentication credential for the netsuite connector: 'accountId|consumerKey|consumerSecret|tokenId|tokenSecret'.",
    };
  }
  const cred = parseNetSuiteCredential(stored);
  if (!cred)
    return {
      error:
        "NetSuite credential is malformed. Expected 'accountId|consumerKey|consumerSecret|tokenId|tokenSecret' (TBA, HMAC-SHA256).",
    };
  return { ns: new NetSuiteClient(cred) };
}

function wrap(e: unknown) {
  return { ok: false as const, error: e instanceof Error ? e.message : "NetSuite request failed" };
}

const recordType = z
  .string()
  .describe("REST record type in scriptId form, e.g. customer, salesOrder, invoice, item, employee, or a custom record customrecord_x");
const fieldsSchema = z
  .record(z.string(), z.unknown())
  .describe('Field values in REST record JSON shape, e.g. {"entityName":"Acme","companyName":"Acme Inc"}; sublists like {"item":{"items":[...]}}');

// Canonical tool registry: contract operations in netsuite.openapi.yaml must
// match these names exactly (pinned by scripts/check-netsuite-contract.mjs).
export const NS_TOOLS: { name: string; description: string; endpoint: string }[] = [
  { name: "suiteql", description: "SuiteQL query with automatic offset paging", endpoint: "POST /query/v1/suiteql" },
  { name: "get_record", description: "Read one record by internal Id or eid:<externalId>", endpoint: "GET /record/v1/{type}/{id}" },
  { name: "list_records", description: "List a record type with paging", endpoint: "GET /record/v1/{type}" },
  { name: "create_record", description: "Create one record", endpoint: "POST /record/v1/{type}" },
  { name: "update_record", description: "Patch one record, optionally replacing sublists", endpoint: "PATCH /record/v1/{type}/{id}" },
  { name: "upsert_record", description: "Create-or-update by external ID", endpoint: "PUT /record/v1/{type}/{externalId}" },
  { name: "delete_record", description: "Delete one record", endpoint: "DELETE /record/v1/{type}/{id}" },
  { name: "batch_upsert", description: "Upsert up to 50 records by external ID", endpoint: "PUT /record/v1/{type}/{externalId} xN" },
  { name: "get_sublist", description: "Read one record's sublist lines (e.g. salesOrder item)", endpoint: "GET /record/v1/{type}/{id}/{sublist}" },
  { name: "transform", description: "Transform a record (salesOrder -> invoice, estimate -> salesOrder)", endpoint: "POST /record/v1/{type}/{id}/!transform/{toType}" },
  { name: "metadata", description: "Record type metadata: fields, sublists and their types", endpoint: "GET /record/v1/metadata-catalog/{type}" },
];

export function buildNetSuiteTools(): Record<string, Tool> {
  const tools: Record<string, Tool> = {};
  // Only a connected account gets its schemas in the prompt (same rule as the SDK).
  if (!readToken("netsuite")) return tools;

  const t = (name: string, description: string, schema: z.ZodTypeAny, execute: (input: unknown) => Promise<unknown>) => {
    tools[`ns_${name}`] = tool({
      description: `NetSuite: ${description}`,
      inputSchema: schema,
      execute: execute as never,
    });
  };

  const fetchErr = (r: { status: number; data: unknown }) => extractNsError(r.data) ?? `HTTP ${r.status}`;

  t(
    "suiteql",
    "Run a SuiteQL query (SQL over NetSuite records, e.g. SELECT id, entityName FROM customer WHERE companyName LIKE 'Acme%'). Follows offset paging up to maxRows.",
    z.object({
      q: z.string().describe("SuiteQL SELECT statement"),
      maxRows: z.number().int().min(1).max(10_000).optional().describe("Cap across pages (default 1000)"),
    }),
    async (i) => {
      const p = client();
      if ("error" in p) return p;
      const { q, maxRows } = i as { q: string; maxRows?: number };
      try {
        const r = await p.ns.suiteQL(q, maxRows);
        return r.ok ? { ok: true, ...(r.data as Record<string, unknown>) } : { ok: false, error: fetchErr(r) };
      } catch (e) {
        return wrap(e);
      }
    },
  );

  t(
    "get_record",
    "Read one record by internal Id or external ID (prefix 'eid:'), optionally expanding all sublists and subresources.",
    z.object({
      recordType,
      id: z.string().describe("Internal Id (e.g. '42') or external Id as 'eid:ext-id'"),
      expandSubResources: z.boolean().optional().describe("Expand all sublists and subresources in one call"),
    }),
    async (i) => {
      const p = client();
      if ("error" in p) return p;
      const { recordType: rt, id, expandSubResources } = i as { recordType: string; id: string; expandSubResources?: boolean };
      try {
        const r = await p.ns.request("GET", `record/v1/${encodeURIComponent(rt)}/${encodeURIComponent(id)}`, {
          query: { expandSubResources: expandSubResources ? "true" : undefined },
        });
        return r.ok ? { ok: true, data: r.data } : { ok: false, error: fetchErr(r) };
      } catch (e) {
        return wrap(e);
      }
    },
  );

  t(
    "list_records",
    "List a record type page by page (internal Ids; use get_record for fields).",
    z.object({
      recordType,
      maxRows: z.number().int().min(1).max(1000).optional().describe("Cap across pages (default 100)"),
    }),
    async (i) => {
      const p = client();
      if ("error" in p) return p;
      const { recordType: rt, maxRows } = i as { recordType: string; maxRows?: number };
      const cap = Math.min(1000, maxRows ?? 100);
      try {
        const items: unknown[] = [];
        let offset = 0;
        for (let page = 0; page < 20 && items.length < cap; page++) {
          const r = await p.ns.request("GET", `record/v1/${encodeURIComponent(rt)}`, { query: { limit: 100, offset } });
          if (!r.ok) return { ok: false, error: fetchErr(r) };
          const d = r.data as { items?: unknown[]; hasMore?: boolean };
          const pageItems = Array.isArray(d.items) ? d.items : [];
          items.push(...pageItems);
          if (!d.hasMore || pageItems.length === 0) break;
          offset += pageItems.length;
        }
        return { ok: true, items, fetched: items.length, truncated: items.length >= cap };
      } catch (e) {
        return wrap(e);
      }
    },
  );

  t(
    "create_record",
    "Create a record of any REST record type.",
    z.object({ recordType, fields: fieldsSchema }),
    async (i) => {
      const p = client();
      if ("error" in p) return p;
      const { recordType: rt, fields } = i as { recordType: string; fields: Record<string, unknown> };
      try {
        const r = await p.ns.request("POST", `record/v1/${encodeURIComponent(rt)}`, { body: fields });
        const id = (r.data as { id?: string } | null)?.id;
        return r.ok ? { ok: true, id } : { ok: false, error: fetchErr(r) };
      } catch (e) {
        return wrap(e);
      }
    },
  );

  t(
    "update_record",
    "Patch a record by internal Id or 'eid:externalId'. Sublists sent in the body are appended by default; use replaceSublists to overwrite them.",
    z.object({
      recordType,
      id: z.string().describe("Internal Id or external Id as 'eid:ext-id'"),
      fields: fieldsSchema,
      replaceSublists: z
        .array(z.string())
        .optional()
        .describe("Sublist names whose lines are replaced (REST 'replace' query param), e.g. [\"item\"]"),
    }),
    async (i) => {
      const p = client();
      if ("error" in p) return p;
      const { recordType: rt, id, fields, replaceSublists } = i as {
        recordType: string;
        id: string;
        fields: Record<string, unknown>;
        replaceSublists?: string[];
      };
      try {
        const r = await p.ns.request("PATCH", `record/v1/${encodeURIComponent(rt)}/${encodeURIComponent(id)}`, {
          body: fields,
          query: { replace: replaceSublists?.join(",") },
        });
        return r.ok ? { ok: true } : { ok: false, error: fetchErr(r) };
      } catch (e) {
        return wrap(e);
      }
    },
  );

  t(
    "upsert_record",
    "Create or update a record keyed by external ID: creates if the external ID is new, updates otherwise. Set the record's externalId field by including 'externalid' in fields.",
    z.object({
      recordType,
      externalId: z.string(),
      fields: fieldsSchema,
    }),
    async (i) => {
      const p = client();
      if ("error" in p) return p;
      const { recordType: rt, externalId, fields } = i as { recordType: string; externalId: string; fields: Record<string, unknown> };
      try {
        const r = await p.ns.request("PUT", `record/v1/${encodeURIComponent(rt)}/${encodeURIComponent(externalId)}`, { body: fields });
        if (!r.ok) return { ok: false, error: fetchErr(r) };
        // The 204 upsert response carries the record Id in its Location header.
        const id = r.location?.split("/").filter(Boolean).pop() ?? null;
        return { ok: true, id };
      } catch (e) {
        return wrap(e);
      }
    },
  );

  t("delete_record", "Delete a record by internal Id or 'eid:externalId'.", z.object({ recordType, id: z.string() }), async (i) => {
    const p = client();
    if ("error" in p) return p;
    const { recordType: rt, id } = i as { recordType: string; id: string };
    try {
      const r = await p.ns.request("DELETE", `record/v1/${encodeURIComponent(rt)}/${encodeURIComponent(id)}`);
      return r.ok ? { ok: true } : { ok: false, error: fetchErr(r) };
    } catch (e) {
      return wrap(e);
    }
  });

  t(
    "batch_upsert",
    "Upsert up to 50 records by external ID in sequence, reporting each result individually.",
    z.object({
      recordType,
      records: z
        .array(z.object({ externalId: z.string(), fields: fieldsSchema }))
        .min(1)
        .max(50),
    }),
    async (i) => {
      const p = client();
      if ("error" in p) return p;
      const { recordType: rt, records } = i as {
        recordType: string;
        records: { externalId: string; fields: Record<string, unknown> }[];
      };
      try {
        const results: { externalId: string; ok: boolean; id?: string | null; error?: string }[] = [];
        for (const rec of records) {
          const r = await p.ns.request("PUT", `record/v1/${encodeURIComponent(rt)}/${encodeURIComponent(rec.externalId)}`, {
            body: rec.fields,
          });
          results.push(
            r.ok
              ? { externalId: rec.externalId, ok: true, id: r.location?.split("/").filter(Boolean).pop() ?? null }
              : { externalId: rec.externalId, ok: false, error: fetchErr(r) },
          );
        }
        return { ok: results.every((x) => x.ok), results };
      } catch (e) {
        return wrap(e);
      }
    },
  );

  t(
    "get_sublist",
    "Read one sublist of a record (e.g. salesOrder item lines, invoice item, journalEntry lineList).",
    z.object({
      recordType,
      id: z.string(),
      sublist: z.string().describe("Sublist scriptId, e.g. 'item', 'lineList', 'expense'"),
    }),
    async (i) => {
      const p = client();
      if ("error" in p) return p;
      const { recordType: rt, id, sublist } = i as { recordType: string; id: string; sublist: string };
      try {
        const r = await p.ns.request(
          "GET",
          `record/v1/${encodeURIComponent(rt)}/${encodeURIComponent(id)}/${encodeURIComponent(sublist)}`,
        );
        return r.ok ? { ok: true, data: r.data } : { ok: false, error: fetchErr(r) };
      } catch (e) {
        return wrap(e);
      }
    },
  );

  t(
    "transform",
    "Transform one record into another: salesOrder -> invoice, estimate -> salesOrder, opportunity -> estimate, etc. Extra fields populate the new record.",
    z.object({
      recordType,
      id: z.string(),
      toType: recordType,
      fields: z.record(z.string(), z.unknown()).optional().describe("Fields to set on the new record, e.g. memo"),
    }),
    async (i) => {
      const p = client();
      if ("error" in p) return p;
      const { recordType: rt, id, toType, fields } = i as {
        recordType: string;
        id: string;
        toType: string;
        fields?: Record<string, unknown>;
      };
      try {
        const r = await p.ns.request(
          "POST",
          `record/v1/${encodeURIComponent(rt)}/${encodeURIComponent(id)}/!transform/${encodeURIComponent(toType)}`,
          { body: fields ?? {} },
        );
        const newId = (r.data as { id?: string } | null)?.id;
        return r.ok ? { ok: true, id: newId } : { ok: false, error: fetchErr(r) };
      } catch (e) {
        return wrap(e);
      }
    },
  );

  t(
    "metadata",
    "Record type metadata from the REST metadata catalog: every field and sublist with its type, requiredness and select options — needed before writing custom or unfamiliar fields.",
    z.object({ recordType }),
    async (i) => {
      const p = client();
      if ("error" in p) return p;
      const { recordType: rt } = i as { recordType: string };
      try {
        const r = await p.ns.request("GET", `record/v1/metadata-catalog/${encodeURIComponent(rt)}`);
        return r.ok ? { ok: true, data: r.data } : { ok: false, error: fetchErr(r) };
      } catch (e) {
        return wrap(e);
      }
    },
  );

  return tools;
}
