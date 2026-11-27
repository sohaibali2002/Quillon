// Deep native HubSpot integration, built against the official API docs
// (https://developers.hubspot.com/docs/api/overview). Goes well beyond the
// generic recipe actions: CRM search (filter DSL with full pagination), full
// object CRUD for core + custom objects, batch read and batch upsert by unique
// property, associations (v4, with labels), deal/quote line items, pipelines
// and stages, engagement logging (notes, emails, calls, tasks, meetings), and
// owners.
//
// Auth: Private App token (hubspot connector "pat") — `Authorization: Bearer`.
// Base: https://api.hubapi.com, CRM v3 (`/crm/v3`), associations v4.
import { tool, type Tool } from "ai";
import { z } from "zod";
import { readToken } from "./connectors";

const BASE = "https://api.hubapi.com";

/** One filter of the CRM v3 search DSL. Groups are ORed together; filters
 *  inside a group are ANDed. Example: filterGroups=[[{propertyName:"amount",
 *  operator:"GT", value:1000}],[{propertyName:"dealname",operator:"EQ",
 *  value:"Acme"}]] = amount > 1000 OR dealname = Acme. */
const filterSchema = z.object({
  propertyName: z.string(),
  operator: z.enum([
    "EQ", "NEQ", "LT", "LTE", "GT", "GTE", "BETWEEN", "IN", "NOT_IN",
    "HAS_PROPERTY", "NOT_HAS_PROPERTY", "CONTAINS_TOKEN", "NOT_CONTAINS_TOKEN",
  ]),
  value: z.union([z.string(), z.number()]).optional(),
  values: z.array(z.union([z.string(), z.number()])).optional().describe("For BETWEEN / IN operators"),
  highValue: z.union([z.string(), z.number()]).optional().describe("Upper bound for BETWEEN"),
});

export class HubSpotClient {
  private token: string;

  constructor(token: string) {
    this.token = token;
  }

  private headers(contentType?: string): Record<string, string> {
    const h: Record<string, string> = { authorization: `Bearer ${this.token}` };
    if (contentType) h["content-type"] = contentType;
    return h;
  }

  /** One API call. HubSpot reports failures as HTTP 4xx/5xx with an error
   *  body ({status:"error",...}) and rate limits as 429 + Retry-After. */
  async request(
    method: string,
    path: string,
    init?: { body?: unknown; query?: Record<string, string | undefined>; retry?: number },
  ): Promise<{ status: number; ok: boolean; data: unknown }> {
    const url = new URL(`${BASE}/${path.replace(/^\/+/, "")}`);
    for (const [k, v] of Object.entries(init?.query ?? {})) if (v !== undefined) url.searchParams.set(k, v);
    const res = await fetch(url, {
      method,
      headers: this.headers(init?.body !== undefined ? "application/json" : undefined),
      body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
      signal: AbortSignal.timeout(30_000),
    });
    const data: unknown = res.status === 204 ? null : await res.json().catch(() => ({}));
    // One retry honoring Retry-After on a rate-limit 429.
    if (res.status === 429 && (init?.retry ?? 0) < 1) {
      const after = Number(res.headers.get("retry-after") ?? "1");
      await new Promise((r) => setTimeout(r, Math.min(5000, (Number.isFinite(after) ? after : 1) * 1000)));
      return this.request(method, path, { ...init, retry: 1 });
    }
    const ok =
      res.ok &&
      !(data && typeof data === "object" && (data as { status?: string }).status === "error");
    return { status: res.status, ok, data };
  }

  /** Search with full paging: follows `after` up to maxResults. */
  async searchAll(objectType: string, body: Record<string, unknown>, maxResults = 200) {
    const cap = Math.min(10_000, Math.max(10, maxResults));
    const results: unknown[] = [];
    let after: string | number | undefined;
    let total = 0;
    for (let page = 0; page < 100; page++) {
      const payload: Record<string, unknown> = { ...body, limit: Math.min(100, cap - results.length) };
      if (after !== undefined) payload.after = after;
      const r = await this.request("POST", `crm/v3/objects/${encodeURIComponent(objectType)}/search`, { body: payload });
      if (!r.ok) return r;
      total = (r.data as { total?: number }).total ?? total;
      const pageResults = Array.isArray((r.data as { results?: unknown[] }).results)
        ? (r.data as { results: unknown[] }).results
        : [];
      results.push(...pageResults);
      after = (r.data as { paging?: { next?: { after?: string | number } } }).paging?.next?.after;
      if (!after || results.length >= cap || pageResults.length === 0) break;
    }
    return { status: 200, ok: true, data: { total, results, fetched: results.length } };
  }
}

/** HubSpot v3 error bodies: {status:"error", message, category, errors:[...]} */
export function extractHsError(data: unknown): string | null {
  if (data && typeof data === "object" && (data as { status?: unknown }).status === "error") {
    const d = data as { message?: string; category?: string; errors?: { message?: string }[] };
    const extra = d.errors?.map((e) => e.message).filter(Boolean).join("; ");
    return [d.category, d.message, extra].filter(Boolean).join(": ") || "HubSpot error";
  }
  return null;
}

function client(): { hs: HubSpotClient } | { error: string } {
  const token = readToken("hubspot");
  if (!token) return { error: "HubSpot is not connected. Add a Private App token for the hubspot connector in the Connectors panel." };
  return { hs: new HubSpotClient(token) };
}

function wrap(e: unknown) {
  return { ok: false as const, error: e instanceof Error ? e.message : "HubSpot request failed" };
}

const objectType = z
  .string()
  .describe("CRM object type: contacts, companies, deals, tickets, products, quotes, calls, emails, meetings, notes, tasks, or a custom object p<id>");
const propsSchema = z.record(z.string(), z.unknown()).describe("Property name to value, e.g. {\"firstname\":\"Ada\",\"email\":\"ada@acme.com\"}");

// Canonical tool registry: contract operations in hubspot.openapi.yaml must
// match these names exactly (pinned by scripts/check-hubspot-contract.mjs).
export const HS_TOOLS: { name: string; description: string }[] = [
  { name: "search", description: "CRM search with filter DSL and full pagination" },
  { name: "get_object", description: "Read one record by Id or unique property" },
  { name: "create_object", description: "Create one record" },
  { name: "update_object", description: "Patch one record" },
  { name: "delete_object", description: "Archive one record" },
  { name: "batch_read", description: "Read up to 100 records by Id" },
  { name: "batch_upsert", description: "Upsert up to 100 records by unique property" },
  { name: "associate", description: "Associate two records (v4, optional label)" },
  { name: "list_associations", description: "List associated records" },
  { name: "add_line_items", description: "Create line items and attach to a deal/quote" },
  { name: "pipelines", description: "List pipelines and stages" },
  { name: "log_engagement", description: "Log a note/email/call/task/meeting on records" },
  { name: "owners", description: "List owners for assignment" },
];

export function buildHubSpotTools(): Record<string, Tool> {
  const tools: Record<string, Tool> = {};
  // Only a connected org gets its schemas in the prompt (same rule as the SDK).
  if (!readToken("hubspot")) return tools;

  const t = (name: string, description: string, schema: z.ZodTypeAny, execute: (input: unknown) => Promise<unknown>) => {
    tools[`hs_${name}`] = tool({
      description: `HubSpot: ${description}`,
      inputSchema: schema,
      execute: execute as never,
    });
  };

  t(
    "search",
    "Search any CRM object with the filter DSL. Groups are ORed, filters inside a group are ANDed. Follows paging up to maxResults.",
    z.object({
      objectType,
      filterGroups: z.array(z.array(filterSchema)).max(3).optional(),
      query: z.string().optional().describe("Free-text search across the object's search index"),
      properties: z.array(z.string()).optional().describe("Property names to return"),
      sorts: z.array(z.string()).optional().describe("e.g. [\"amount:DESC\"]"),
      maxResults: z.number().int().min(10).max(10_000).optional().describe("Cap across pages (default 200)"),
    }),
    async (i) => {
      const p = client();
      if ("error" in p) return p;
      const { objectType: ot, filterGroups, query, properties, sorts, maxResults } = i as {
        objectType: string; filterGroups?: unknown; query?: string; properties?: string[]; sorts?: string[]; maxResults?: number;
      };
      try {
        const body: Record<string, unknown> = {};
        if (filterGroups) body.filterGroups = filterGroups;
        if (query) body.query = query;
        if (properties) body.properties = properties;
        if (sorts) body.sorts = sorts;
        const r = await p.hs.searchAll(ot, body, maxResults);
        return r.ok ? { ok: true, ...(r.data as Record<string, unknown>) } : { ok: false, error: extractHsError(r.data) ?? `HTTP ${r.status}` };
      } catch (e) {
        return wrap(e);
      }
    },
  );

  t(
    "get_object",
    "Read one record by Id (or by a unique-value property via idProperty), with optional property projection and associations.",
    z.object({
      objectType,
      id: z.string(),
      properties: z.array(z.string()).optional(),
      associations: z.array(z.string()).optional().describe("Object types to include, e.g. [\"contacts\"]"),
      idProperty: z.string().optional().describe("Look up by this unique property's value instead of the record Id"),
    }),
    async (i) => {
      const p = client();
      if ("error" in p) return p;
      const { objectType: ot, id, properties, associations, idProperty } = i as {
        objectType: string; id: string; properties?: string[]; associations?: string[]; idProperty?: string;
      };
      try {
        if (idProperty) {
          const s = await p.hs.searchAll(ot, {
            filterGroups: [[{ propertyName: idProperty, operator: "EQ", value: id }]],
            properties,
            limit: 1,
          });
          return s.ok ? { ok: true, ...(s.data as Record<string, unknown>) } : { ok: false, error: extractHsError(s.data) ?? `HTTP ${s.status}` };
        }
        const r = await p.hs.request("GET", `crm/v3/objects/${encodeURIComponent(ot)}/${encodeURIComponent(id)}`, {
          query: { properties: properties?.join(","), associations: associations?.join(",") },
        });
        return r.ok ? { ok: true, data: r.data } : { ok: false, error: extractHsError(r.data) ?? `HTTP ${r.status}` };
      } catch (e) {
        return wrap(e);
      }
    },
  );

  t(
    "create_object",
    "Create one record with property values.",
    z.object({ objectType, properties: propsSchema }),
    async (i) => {
      const p = client();
      if ("error" in p) return p;
      const { objectType: ot, properties } = i as { objectType: string; properties: Record<string, unknown> };
      try {
        const r = await p.hs.request("POST", `crm/v3/objects/${encodeURIComponent(ot)}`, { body: { properties } });
        return r.ok ? { ok: true, data: r.data } : { ok: false, error: extractHsError(r.data) ?? `HTTP ${r.status}` };
      } catch (e) {
        return wrap(e);
      }
    },
  );

  t(
    "update_object",
    "Patch one record by Id; send only the properties to change.",
    z.object({ objectType, id: z.string(), properties: propsSchema }),
    async (i) => {
      const p = client();
      if ("error" in p) return p;
      const { objectType: ot, id, properties } = i as { objectType: string; id: string; properties: Record<string, unknown> };
      try {
        const r = await p.hs.request("PATCH", `crm/v3/objects/${encodeURIComponent(ot)}/${encodeURIComponent(id)}`, { body: { properties } });
        return r.ok ? { ok: true, data: r.data } : { ok: false, error: extractHsError(r.data) ?? `HTTP ${r.status}` };
      } catch (e) {
        return wrap(e);
      }
    },
  );

  t(
    "delete_object",
    "Delete (archive) one record by Id.",
    z.object({ objectType, id: z.string() }),
    async (i) => {
      const p = client();
      if ("error" in p) return p;
      const { objectType: ot, id } = i as { objectType: string; id: string };
      try {
        const r = await p.hs.request("DELETE", `crm/v3/objects/${encodeURIComponent(ot)}/${encodeURIComponent(id)}`);
        return r.status === 204 ? { ok: true, id } : { ok: false, error: extractHsError(r.data) ?? `HTTP ${r.status}` };
      } catch (e) {
        return wrap(e);
      }
    },
  );

  t(
    "batch_read",
    "Read up to 100 records by Id list in one call.",
    z.object({
      objectType,
      ids: z.array(z.string()).max(100),
      properties: z.array(z.string()).optional(),
    }),
    async (i) => {
      const p = client();
      if ("error" in p) return p;
      const { objectType: ot, ids, properties } = i as { objectType: string; ids: string[]; properties?: string[] };
      try {
        const r = await p.hs.request("POST", `crm/v3/objects/${encodeURIComponent(ot)}/batch/read`, {
          body: { inputs: ids.map((id) => ({ id })), properties },
        });
        return r.ok ? { ok: true, data: r.data } : { ok: false, error: extractHsError(r.data) ?? `HTTP ${r.status}` };
      } catch (e) {
        return wrap(e);
      }
    },
  );

  t(
    "batch_upsert",
    "Create or update up to 100 records keyed by a unique-value property (idProperty) in one call.",
    z.object({
      objectType,
      idProperty: z.string().describe("Unique property key, e.g. email for contacts"),
      records: z.array(z.object({ id: z.string(), properties: propsSchema })).max(100),
    }),
    async (i) => {
      const p = client();
      if ("error" in p) return p;
      const { objectType: ot, idProperty, records } = i as {
        objectType: string; idProperty: string; records: { id: string; properties: Record<string, unknown> }[];
      };
      try {
        const r = await p.hs.request("POST", `crm/v3/objects/${encodeURIComponent(ot)}/batch/upsert`, {
          body: { inputs: records.map((rec) => ({ idProperty, id: rec.id, properties: rec.properties })) },
        });
        return r.ok ? { ok: true, data: r.data } : { ok: false, error: extractHsError(r.data) ?? `HTTP ${r.status}` };
      } catch (e) {
        return wrap(e);
      }
    },
  );

  t(
    "associate",
    "Associate two records (e.g. contact -> company) with a HUBSPOT_DEFINED definition Id, optionally with a label.",
    z.object({
      fromObjectType: objectType,
      fromId: z.string(),
      toObjectType: objectType,
      toId: z.string(),
      definitionId: z.number().int().describe("Association type id, e.g. contact->company 1, company->contact 279, deal->contact 3"),
      label: z.string().optional().describe("Custom association label"),
    }),
    async (i) => {
      const p = client();
      if ("error" in p) return p;
      const { fromObjectType: from, fromId, toObjectType: to, toId, definitionId, label } = i as {
        fromObjectType: string; fromId: string; toObjectType: string; toId: string; definitionId: number; label?: string;
      };
      try {
        const r = await p.hs.request(
          "PUT",
          `crm/v4/objects/${encodeURIComponent(from)}/${encodeURIComponent(fromId)}/associations/${encodeURIComponent(to)}/${encodeURIComponent(toId)}`,
          {
            body: [
              {
                associationCategory: "HUBSPOT_DEFINED",
                associationTypeId: definitionId,
                ...(label ? { label } : {}),
              },
            ],
          },
        );
        return r.ok ? { ok: true, data: r.data } : { ok: false, error: extractHsError(r.data) ?? `HTTP ${r.status}` };
      } catch (e) {
        return wrap(e);
      }
    },
  );

  t(
    "list_associations",
    "List records associated to one record for a given target object type.",
    z.object({ objectType, id: z.string(), toObjectType: objectType }),
    async (i) => {
      const p = client();
      if ("error" in p) return p;
      const { objectType: ot, id, toObjectType: to } = i as { objectType: string; id: string; toObjectType: string };
      try {
        const r = await p.hs.request("GET", `crm/v4/objects/${encodeURIComponent(ot)}/${encodeURIComponent(id)}/associations/${encodeURIComponent(to)}`);
        return r.ok ? { ok: true, data: r.data } : { ok: false, error: extractHsError(r.data) ?? `HTTP ${r.status}` };
      } catch (e) {
        return wrap(e);
      }
    },
  );

  t(
    "add_line_items",
    "Create line items (quantity + unit price) in a batch and associate each to a deal or quote.",
    z.object({
      parentObjectType: z.enum(["deals", "quotes"]),
      parentId: z.string(),
      lineItems: z
        .array(
          z.object({
            name: z.string(),
            quantity: z.number().positive(),
            price: z.number().nonnegative().describe("Unit price"),
          }),
        )
        .min(1)
        .max(100),
    }),
    async (i) => {
      const p = client();
      if ("error" in p) return p;
      const { parentObjectType: parent, parentId, lineItems } = i as {
        parentObjectType: "deals" | "quotes"; parentId: string; lineItems: { name: string; quantity: number; price: number }[];
      };
      try {
        const created = await p.hs.request("POST", "crm/v3/objects/line_items/batch/create", {
          body: {
            inputs: lineItems.map((li) => ({
              properties: { name: li.name, quantity: String(li.quantity), price: String(li.price) },
            })),
          },
        });
        if (!created.ok) return { ok: false, error: extractHsError(created.data) ?? `HTTP ${created.status}` };
        const ids = (created.data as { results?: { id?: string }[] }).results?.map((x) => x.id).filter((x): x is string => !!x) ?? [];
        // line_item->deal = 20, line_item->quote = 63 (HUBSPOT_DEFINED type ids).
        const typeId = parent === "deals" ? 20 : 63;
        const associations: { lineItemId: string; ok: boolean; status: number }[] = [];
        for (const id of ids) {
          const a = await p.hs.request(
            "PUT",
            `crm/v4/objects/line_items/${id}/associations/${parent}/${parentId}`,
            { body: [{ associationCategory: "HUBSPOT_DEFINED", associationTypeId: typeId }] },
          );
          associations.push({ lineItemId: id, ok: a.ok, status: a.status });
        }
        return { ok: associations.length > 0 && associations.every((a) => a.ok), lineItemIds: ids, associations };
      } catch (e) {
        return wrap(e);
      }
    },
  );

  t(
    "pipelines",
    "List pipelines and their stages for deals or tickets, so stage labels can be resolved to stage ids.",
    z.object({ objectType: z.enum(["deals", "tickets"]) }),
    async (i) => {
      const p = client();
      if ("error" in p) return p;
      const { objectType: ot } = i as { objectType: "deals" | "tickets" };
      try {
        const r = await p.hs.request("GET", `crm/v3/pipelines/${encodeURIComponent(ot)}`);
        return r.ok ? { ok: true, data: r.data } : { ok: false, error: extractHsError(r.data) ?? `HTTP ${r.status}` };
      } catch (e) {
        return wrap(e);
      }
    },
  );

  t(
    "log_engagement",
    "Log an engagement (note, email, call, task, meeting) on a record and associate it.",
    z.object({
      type: z.enum(["note", "email", "call", "task", "meeting"]),
      body: z.string().describe("Engagement content, e.g. the note text"),
      toObjectType: objectType,
      toId: z.string(),
      subject: z.string().optional(),
      status: z.string().optional().describe("For tasks: NOT_STARTED, IN_PROGRESS, COMPLETED, ..."),
      dueAt: z.string().optional().describe("ISO timestamp for tasks/meetings"),
    }),
    async (i) => {
      const p = client();
      if ("error" in p) return p;
      const { type, body, toObjectType: to, toId, subject, status, dueAt } = i as {
        type: string; body: string; toObjectType: string; toId: string; subject?: string; status?: string; dueAt?: string;
      };
      try {
        const subjectProps = subject
          ? { hs_email_subject: subject, hs_call_title: subject, hs_task_subject: subject, hs_meeting_title: subject }
          : {};
        const propsForType: Record<string, Record<string, unknown>> = {
          note: { hs_note_body: body, ...subjectProps },
          email: { hs_email_body: body, ...subjectProps },
          call: { hs_call_body: body, hs_call_status: status ?? "COMPLETED", ...subjectProps },
          task: { hs_task_body: body, hs_task_status: status ?? "NOT_STARTED", ...subjectProps },
          meeting: { hs_meeting_body: body, ...subjectProps },
        };
        if (dueAt) propsForType[type].hs_timestamp = dueAt;
        const created = await p.hs.request("POST", `crm/v3/objects/${type}`, { body: { properties: propsForType[type] } });
        if (!created.ok) return { ok: false, error: extractHsError(created.data) ?? `HTTP ${created.status}` };
        const id = (created.data as { id?: string }).id;
        if (!id) return { ok: false, error: "Engagement created but no id returned" };
        // note->contact 228, email->contact 198, call->contact 194,
        // task->contact 216, meeting->contact 212 (HUBSPOT_DEFINED type ids).
        const typeIds: Record<string, number> = { note: 228, email: 198, call: 194, task: 216, meeting: 212 };
        const assoc = await p.hs.request(
          "PUT",
          `crm/v4/objects/${type}/${id}/associations/${encodeURIComponent(to)}/${encodeURIComponent(toId)}`,
          { body: [{ associationCategory: "HUBSPOT_DEFINED", associationTypeId: typeIds[type] }] },
        );
        return {
          ok: assoc.ok,
          engagementId: id,
          association: assoc.ok ? "linked" : `association failed with ${assoc.status}`,
        };
      } catch (e) {
        return wrap(e);
      }
    },
  );

  t(
    "owners",
    "List HubSpot owners so records can be assigned by name or email.",
    z.object({}),
    async () => {
      const p = client();
      if ("error" in p) return p;
      try {
        const r = await p.hs.request("GET", "crm/v3/owners");
        return r.ok ? { ok: true, data: r.data } : { ok: false, error: extractHsError(r.data) ?? `HTTP ${r.status}` };
      } catch (e) {
        return wrap(e);
      }
    },
  );

  return tools;
}
