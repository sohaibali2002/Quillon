// Exercises the deep NetSuite integration against a local mock of the
// SuiteTalk REST Web Services: OAuth 1.0 TBA signature verification, SuiteQL
// paging, record CRUD, external-ID upsert, transform, sublist, metadata
// catalog, nsError surface, and a 503 concurrency-limit retry. No live account.
import { register } from "node:module";
register("./ts-resolve.mjs", import.meta.url);
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";

const { NetSuiteClient, extractNsError, realmOf, parseNetSuiteCredential, pct } = await import("../src/lib/netsuite.ts");

const ACCOUNT_ID = "123456-sb1";
const CONSUMER_SECRET = "consumer-secret";
const TOKEN_SECRET = "token-secret";

function respond(res, code, body) {
  res.writeHead(code, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

/** Verify the client's OAuth 1.0 HMAC-SHA256 signature against the original
 *  request URL (the client signs the real suitetalk URL before fetch is
 *  redirected to the mock). Returns the parsed oauth params. */
function verifyAuth(req, reqUrl) {
  const auth = req.headers.authorization ?? "";
  assert.match(auth, /^OAuth /);
  const params = Object.fromEntries(
    [...auth.matchAll(/([\w:]+)="([^"]*)"/g)].map((m) => [m[1], decodeURIComponent(m[2])]),
  );
  assert.equal(params.realm, realmOf(ACCOUNT_ID), "realm is the account id with hyphens underscored and uppercased");
  assert.equal(params.oauth_signature_method, "HMAC-SHA256");
  assert.equal(params.oauth_version, "1.0");
  assert.equal(params.oauth_consumer_key, "consumer-key");
  assert.equal(params.oauth_token, "token-id");
  const url = new URL(`https://${ACCOUNT_ID}.suitetalk.api.netsuite.com${reqUrl}`);
  const all = [...url.searchParams.entries(), ...Object.entries(params)].filter(([k]) => k !== "realm" && k !== "oauth_signature");
  const base = [
    req.method.toUpperCase(),
    pct(url.origin + url.pathname),
    pct(all.map(([k, v]) => [pct(k), pct(v)]).sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : 1) : a[0] < b[0] ? -1 : 1)).map(([k, v]) => `${k}=${v}`).join("&")),
  ].join("&");
  const expected = createHmac("sha256", `${CONSUMER_SECRET}&${TOKEN_SECRET}`).update(base).digest("base64");
  assert.equal(params.oauth_signature, expected, `OAuth signature must verify for ${req.method} ${url.pathname}`);
  return params;
}

const state = { suiteqlHits: 0, bulkHits: 0, retried: null };

const server = (await import("node:http")).createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", async () => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
    const path = url.pathname.replace(/^\/services\/rest/, "");
    const body = raw ? JSON.parse(raw) : null;

    if (path === "/query/v1/suiteql") {
      state.suiteqlHits++;
      assert.equal(body.q.includes("SELECT"), true);
      assert.equal(url.searchParams.get("limit"), "100");
      verifyAuth(req, req.url);
      if (state.suiteqlHits === 1) {
        respond(res, 200, { items: [{ id: 1, entityName: "A" }, { id: 2, entityName: "B" }], hasMore: true, totalResults: 3 });
      } else {
        assert.equal(url.searchParams.get("offset"), "2");
        respond(res, 200, { items: [{ id: 3, entityName: "C" }], hasMore: false, totalResults: 3 });
      }
      return;
    }
    if (path === "/record/v1/customer/42") {
      verifyAuth(req, req.url);
      respond(res, 200, { id: "42", entityName: "Acme" });
      return;
    }
    if (path === "/record/v1/customer") {
      verifyAuth(req, req.url);
      respond(res, 201, { id: "501" });
      return;
    }
    if (path === "/record/v1/salesOrder/100/item") {
      verifyAuth(req, req.url);
      respond(res, 200, { items: [{ item: { id: "23" }, quantity: 2 }, { item: { id: "24" }, quantity: 1 }] });
      return;
    }
    if (path === "/record/v1/salesOrder/100/!transform/invoice") {
      verifyAuth(req, req.url);
      assert.equal(body.memo, "auto-billed");
      respond(res, 201, { id: "888" });
      return;
    }
    if (path === "/record/v1/customer/ACME-1") {
      state.bulkHits++;
      verifyAuth(req, req.url);
      res.writeHead(204, {
        location: `https://${ACCOUNT_ID}.suitetalk.api.netsuite.com/services/rest/record/v1/customer/77${state.bulkHits}`,
      });
      res.end();
      return;
    }
    if (path === "/record/v1/customer/444") {
      if (req.method === "DELETE") {
        verifyAuth(req, req.url);
        res.writeHead(204);
        res.end();
        return;
      }
      assert.equal(url.searchParams.get("replace"), "contact");
      res.writeHead(204);
      res.end();
      return;
    }
    if (path === "/record/v1/metadata-catalog/customer") {
      verifyAuth(req, req.url);
      respond(res, 200, { items: [{ name: "companyName", type: "string", required: true }, { name: "item", type: "sublist" }] });
      return;
    }
    if (path === "/record/v1/gone/1") {
      // Concurrency-limit simulation: 503 once, then success — retried once.
      state.retried = (state.retried ?? 0) + 1;
      if (state.retried === 1) {
        res.writeHead(503, { "content-type": "application/json" });
        res.end(JSON.stringify({ type: "https://www.netsuite.com/jsonerror", title: "SSS_REQUEST_LIMIT_EXCEEDED" }));
      } else {
        respond(res, 200, { id: "1" });
      }
      return;
    }
    respond(res, 404, {
      type: "https://www.netsuite.com/jsonerror",
      title: "Record not found",
      status: 404,
      detail: "Customer 999 does not exist",
      "o:errorCode": "USER_ERROR",
      "o:errorDetails": [{ detail: "no customer 999", "o:errorCode": "NS_NOT_FOUND" }],
      "o:correlationId": "abc123",
    });
  });
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;

const realFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const u = typeof input === "string" ? new URL(input) : input instanceof URL ? new URL(input.href) : new URL(input.url);
  const redirected = new URL(u.pathname + u.search, base);
  return realFetch(redirected, init);
};

// Unit helpers
assert.deepEqual(parseNetSuiteCredential("a|b|c|d|e")?.accountId, "a");
assert.equal(parseNetSuiteCredential("a|b|c|d"), null);
assert.equal(parseNetSuiteCredential("a||c|d|e"), null);
assert.equal(realmOf("123456-sb1"), "123456_SB1");
assert.equal(realmOf("123456"), "123456");
console.log("PASS helpers: credential parsing and realm mapping");

// Error extraction
assert.equal(
  extractNsError({
    type: "https://www.netsuite.com/jsonerror",
    title: "Record not found",
    detail: "Customer 999 does not exist",
    "o:errorCode": "USER_ERROR",
    "o:errorDetails": [{ detail: "no customer 999", "o:errorCode": "NS_NOT_FOUND" }],
  }),
  "USER_ERROR: Customer 999 does not exist: NS_NOT_FOUND: no customer 999",
);
assert.equal(extractNsError({ foo: 1 }), null);
console.log("PASS helpers: nsError extraction");

// Credential: parse once for the client
const cred = parseNetSuiteCredential(`${ACCOUNT_ID}|consumer-key|${CONSUMER_SECRET}|token-id|${TOKEN_SECRET}`);
assert.ok(cred);
const ns = new NetSuiteClient(cred);
assert.equal(ns.host, "123456-sb1.suitetalk.api.netsuite.com");

// SuiteQL full pagination across 2 pages (signature verified in-mock)
const q = await ns.suiteQL("SELECT id, entityName FROM customer");
assert.equal(q.ok, true);
assert.deepEqual(q.data.items.map((r) => r.id), [1, 2, 3]);
assert.equal(q.data.fetched, 3);
assert.equal(q.data.hasMore, undefined);
console.log("PASS suiteql: offset paged across 2 pages, 3 rows, OAuth signature verified");

// record CRUD
const g = await ns.request("GET", "record/v1/customer/42");
assert.equal(g.data.entityName, "Acme");
const c = await ns.request("POST", "record/v1/customer", { body: { companyName: "Acme" } });
assert.equal(c.ok, true);
assert.equal(c.data.id, "501");
console.log("PASS records: read and create (201 with id)");

// external-ID upsert: 204 with Location header carrying the record Id
const up = await ns.request("PUT", "record/v1/customer/ACME-1", { body: { companyName: "Acme" } });
assert.equal(up.ok, true);
assert.equal(up.location.split("/").pop(), "771");
console.log("PASS upsert: 204 upsert, Id recovered from Location header");

// transform
const tr = await ns.request("POST", "record/v1/salesOrder/100/!transform/invoice", { body: { memo: "auto-billed" } });
assert.equal(tr.ok, true);
assert.equal(tr.data.id, "888");
console.log("PASS transform: salesOrder -> invoice");

// sublist
const sl = await ns.request("GET", "record/v1/salesOrder/100/item");
assert.equal(sl.data.items.length, 2);
console.log("PASS sublist: salesOrder item lines");

// PATCH with replace param + DELETE
const patch = await ns.request("PATCH", "record/v1/customer/444", {
  body: { comments: "vip" },
  query: { replace: "contact" },
});
assert.equal(patch.ok, true);
const del = await ns.request("DELETE", "record/v1/customer/444");
assert.equal(del.ok, true);
console.log("PASS update/delete: PATCH with replace, DELETE 204");

// metadata catalog
const meta = await ns.request("GET", "record/v1/metadata-catalog/customer");
assert.equal(meta.ok, true);
assert.equal(meta.data.items[0].name, "companyName");
console.log("PASS metadata: catalog fields");

// 503 concurrency limit retried once
const retry = await ns.request("GET", "record/v1/gone/1");
assert.equal(retry.ok, true);
assert.equal(retry.data.id, "1");
console.log("PASS concurrency limit: 503 retried once and succeeded");

// nsError surface
const gone = await ns.request("GET", "record/v1/missing/999");
assert.equal(gone.ok, false);
assert.match(String(extractNsError(gone.data)), /USER_ERROR/);
console.log("PASS error surface: nsError body propagates");

server.close();
process.exit(0);
