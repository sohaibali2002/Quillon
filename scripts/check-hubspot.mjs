// Exercises the deep HubSpot integration against a local mock HubSpot API that
// implements the official endpoints: search with paging, CRUD, batch upsert,
// v4 associations, line items, and a 429 rate-limit retry. No live portal needed.
import { register } from "node:module";
register("./ts-resolve.mjs", import.meta.url);
import assert from "node:assert/strict";

const { HubSpotClient, extractHsError } = await import("../src/lib/hubspot.ts");

const state = { hits: 0 };

function respond(res, code, body) {
  res.writeHead(code, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

const server = (await import("node:http")).createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", async () => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
    assert.match(req.headers.authorization ?? "", /^Bearer test-token$/);
    const path = url.pathname;

    if (path === "/crm/v3/objects/contacts/search") {
      state.hits++;
      const body = JSON.parse(raw);
      // Page 1 returns paging.next.after; page 2 completes.
      if (state.hits === 1) {
        assert.equal(body.limit, 100);
        respond(res, 200, {
          total: 3,
          results: [{ id: "1", properties: { email: "a@x.com" } }, { id: "2", properties: { email: "b@x.com" } }],
          paging: { next: { after: "CURSOR2" } },
        });
      } else {
        assert.equal(body.after, "CURSOR2");
        respond(res, 200, {
          total: 3,
          results: [{ id: "3", properties: { email: "c@x.com" } }],
        });
      }
      return;
    }
    if (path === "/crm/v3/objects/companies") {
      respond(res, 201, { id: "501", properties: JSON.parse(raw).properties });
      return;
    }
    if (path === "/crm/v3/objects/deals/999") {
      respond(res, 200, { id: "999", properties: { dealname: "Big deal" } });
      return;
    }
    if (path === "/crm/v3/objects/contacts/batch/upsert") {
      const body = JSON.parse(raw);
      assert.equal(body.inputs[0].idProperty, "email");
      respond(res, 201, { results: body.inputs.map((inp, i) => ({ id: String(700 + i) })) });
      return;
    }
    if (path === "/crm/v4/objects/contacts/1/associations/companies/501") {
      const body = JSON.parse(raw);
      assert.equal(body[0].associationTypeId, 1);
      respond(res, 200, { status: "OK" });
      return;
    }
    if (path === "/crm/v3/objects/line_items/batch/create") {
      const body = JSON.parse(raw);
      respond(res, 201, { results: body.inputs.map((inp, i) => ({ id: String(900 + i), properties: inp.properties })) });
      return;
    }
    if (path === "/crm/v3/pipelines/deals") {
      respond(res, 200, { results: [{ id: "default", stages: [{ id: "qualify", label: "Qualified" }] }] });
      return;
    }
    if (path === "/crm/v3/objects/notes") {
      respond(res, 201, { id: "777", properties: JSON.parse(raw).properties });
      return;
    }
    if (path === "/crm/v3/owners") {
      respond(res, 200, { results: [{ id: "11", email: "owner@acme.com" }] });
      return;
    }
    if (path === "/crm/v3/objects/tickets/555") {
      // Rate-limit simulation: first call 429 with Retry-After, then success.
      state.rl = (state.rl ?? 0) + 1;
      if (state.rl === 1) {
        res.writeHead(429, { "content-type": "application/json", "retry-after": "1" });
        res.end(JSON.stringify({ status: "error", category: "RATE_LIMITS", message: "rate limit hit" }));
      } else {
        respond(res, 200, { id: "555", properties: { subject: "Fixed" } });
      }
      return;
    }
    if (path === "/crm/v3/objects/gone/1") {
      respond(res, 404, { status: "error", category: "OBJECT_NOT_FOUND", message: "object not found", errors: [{ message: "no ticket 1" }] });
      return;
    }
    respond(res, 404, { status: "error", message: `no route ${path}` });
  });
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;

// Point the client at the mock by patching the module-level BASE via the client
// (request() builds from BASE) — instead, override global fetch to redirect.
const realFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const u = typeof input === "string" ? new URL(input) : input instanceof URL ? new URL(input.href) : new URL(input.url);
  const redirected = new URL(u.pathname + u.search, base);
  return realFetch(redirected, init);
};

// Unit: error extraction
assert.equal(
  extractHsError({ status: "error", category: "OBJECT_NOT_FOUND", message: "not found", errors: [{ message: "no ticket" }] }),
  "OBJECT_NOT_FOUND: not found: no ticket",
);
assert.equal(extractHsError({ foo: 1 }), null);
console.log("PASS helpers: HubSpot error body extraction");

const hs = new HubSpotClient("test-token");

// Full-pagination search across two pages
const q = await hs.searchAll("contacts", { filterGroups: [[{ propertyName: "email", operator: "CONTAINS_TOKEN", value: "x.com" }]] });
assert.equal(q.ok, true);
assert.deepEqual(q.data.results.map((r) => r.id), ["1", "2", "3"]);
assert.equal(q.data.fetched, 3);
assert.equal(q.data.total, 3);
console.log("PASS search: followed after cursor across 2 pages, 3 contacts");

// create + read
const c = await hs.request("POST", "crm/v3/objects/companies", { body: { properties: { name: "Acme" } } });
assert.equal(c.ok, true);
assert.equal(c.data.id, "501");
const d = await hs.request("GET", "crm/v3/objects/deals/999");
assert.equal(d.data.properties.dealname, "Big deal");
console.log("PASS records: create and read");

// batch upsert by idProperty
const up = await hs.request("POST", "crm/v3/objects/contacts/batch/upsert", {
  body: { inputs: [{ idProperty: "email", id: "a@x.com", properties: { firstname: "A" } }, { idProperty: "email", id: "b@x.com", properties: { firstname: "B" } }] },
});
assert.equal(up.ok, true);
assert.deepEqual(up.data.results.map((r) => r.id), ["700", "701"]);
console.log("PASS batch upsert: 2 records keyed by email");

// v4 association with definition id 1 (contact->company)
const a = await hs.request("PUT", "crm/v4/objects/contacts/1/associations/companies/501", {
  body: [{ associationCategory: "HUBSPOT_DEFINED", associationTypeId: 1 }],
});
assert.equal(a.ok, true);
console.log("PASS association: contact->company with definition 1");

// pipelines
const pl = await hs.request("GET", "crm/v3/pipelines/deals");
assert.equal(pl.data.results[0].stages[0].label, "Qualified");
console.log("PASS pipelines: stages listed");

// 429 -> retry once with Retry-After
const t = await hs.request("GET", "crm/v3/objects/tickets/555");
assert.equal(t.ok, true, JSON.stringify(t));
assert.equal(t.data.id, "555");
console.log("PASS rate limit: 429 retried once and succeeded");

// error shape surfaces
const gone = await hs.request("GET", "crm/v3/objects/gone/1");
assert.equal(gone.ok, false);
assert.match(String(extractHsError(gone.data)), /OBJECT_NOT_FOUND/);
console.log("PASS error surface: HubSpot error body propagates");

server.close();
process.exit(0);
