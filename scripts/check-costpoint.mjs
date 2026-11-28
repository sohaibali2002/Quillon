// Exercises the deep Costpoint integration against a local mock of the
// Costpoint REST API (OData v4): OAuth2 token grant + caching + 401 refresh,
// API-key mode, $skip paging, record CRUD with If-Match ETags, batch upsert
// per-record results, labor posting, chained snapshots, and the OData error
// surface. No live environment.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { register } from "node:module";

register("./ts-resolve.mjs", import.meta.url);

// The mock environment listens on loopback; allowed only because this check
// names the destination in both egress settings.
process.env.QUILLON_EGRESS_ALLOWLIST = "127.0.0.1";
process.env.QUILLON_EGRESS_PRIVATE_HOSTS = "127.0.0.1";

const { CostpointClient, parseCostpointCredential, extractCostpointError, keyLiteral, keyPath, serviceRootOf, deleteRecordGuarded, patchRecordGuarded } =
  await import("../src/lib/costpoint.ts");

let passed = 0;
let chain = Promise.resolve();
const check = (name, fn) => {
  chain = chain.then(async () => {
    try {
      await fn();
      console.log(`PASS ${name}`);
      passed++;
    } catch (e) {
      console.error(`FAIL ${name}: ${e.message}`);
      process.exitCode = 1;
    }
  });
};

// ---------- unit: credential parsing ----------
check("parse OAuth2 credential (5 parts)", () => {
  const c = parseCostpointCredential("https://acme.costpointcloud.com|cid|sec|user|pw");
  assert.equal(c.clientId, "cid");
  assert.equal(c.username, "user");
});
check("parse API-key credential (2 parts)", () => {
  const c = parseCostpointCredential("https://acme.costpointcloud.com|key123");
  assert.equal(c.apiKey, "key123");
});
check("reject malformed credentials", () => {
  assert.equal(parseCostpointCredential("a|b|c"), null);
  assert.equal(parseCostpointCredential("a||c|d|e"), null);
});
check("service root and key literals", () => {
  assert.equal(serviceRootOf("https://acme.costpointcloud.com/"), "https://acme.costpointcloud.com/api/v1");
  assert.equal(keyLiteral("P24-1001"), "'P24-1001'");
  assert.equal(keyLiteral(1234), "1234");
  assert.equal(keyLiteral("it's"), "'it''s'");
});
check("extractCostpointError handles string and {value} messages", () => {
  assert.equal(extractCostpointError({ error: { code: "404", message: "not found" } }), "404: not found");
  assert.equal(extractCostpointError({ error: { message: { lang: "en", value: "boom" } } }), "boom");
  assert.equal(extractCostpointError({}), null);
});

// ---------- mock server ----------
const seen = [];
let tokenRequests = 0;
let projectReads = 0;
let patched = [];
let labors = [];
let expiredOnce = false;

const server = createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  const body = [];
  req.on("data", (c) => body.push(c));
  req.on("end", () => {
    const raw = Buffer.concat(body).toString();
    seen.push({ method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), headers: req.headers, raw });
    const reply = (status, data, headers = {}) => {
      res.writeHead(status, { "content-type": "application/json", ...headers });
      res.end(data === null ? "" : JSON.stringify(data));
    };

    if (url.pathname === "/api/oauth2/token") {
      tokenRequests++;
      const form = new URLSearchParams(raw);
      assert.equal(form.get("grant_type"), "password");
      reply(200, { access_token: expiredOnce ? "tok2" : "tok1", expires_in: 3600 });
      return;
    }
    const root = "/api/v1";
    if (!url.pathname.startsWith(root)) return reply(404, { error: { message: "no route" } });
    const rest = url.pathname.slice(root.length);

    if (rest === "/PROJECT('P24-1001')") {
      projectReads++;
      // Second authenticated read gets an expired-token 401; the client must
      // refresh (grant #2) and retry with tok2 successfully.
      const auth = req.headers.authorization ?? "";
      const apiKeyMode = Boolean(req.headers["x-api-key"]);
      if (!apiKeyMode && projectReads === 2 && auth === "Bearer tok1") {
        expiredOnce = true;
        return reply(401, { error: { message: "token expired" } });
      }
      if (expiredOnce && auth === "Bearer tok1") return reply(401, { error: { message: "token expired" } });
      return reply(200, { PROJECT_ID: "P24-1001", DESCRIPTION: "Bridge repair", ORG_ID: "100" }, { etag: 'W/"v3"' });
    }
    if (rest === "/PROJECT('P24-2002')") {
      if (req.method === "GET") return reply(200, { PROJECT_ID: "P24-2002" }, { etag: 'W/"v3"' });
      patched.push(raw);
      return reply(204, null, { etag: 'W/"v4"' });
    }
    if (rest === "/PROJECT('P24-4044')") return reply(404, { error: { code: "404", message: { lang: "en", value: "no such project" } } });
    if (rest === "/PROJECT('P24-7777')") {
      if (req.method === "DELETE") return reply(204, null);
      return reply(200, { PROJECT_ID: "P24-7777" }, { etag: 'W/"v9"' });
    }
    if (rest === "/PROJECT('P24-8888')") {
      // Server that never hands out an ETag: unconditional writes must be refused.
      if (req.method === "DELETE") return reply(204, null);
      return reply(200, { PROJECT_ID: "P24-8888" });
    }
    if (rest === "/LABOR_ACTUALS") {
      labors.push(raw);
      return reply(201, { EMPE_ID: JSON.parse(raw).EMPE_ID });
    }
    if (rest === "/$metadata") {
      res.writeHead(200, { "content-type": "application/xml" });
      res.end('<edmx:Edmx xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx"><edmx:DataServices/></edmx:Edmx>');
      return;
    }
    if (rest === "/PROJECT_BUDGETS" || rest === "/ORGANIZATION" || rest === "/VOUCHER_DETL" || rest === "/EMPE") {
      const top = Number(url.searchParams.get("$top") ?? "0");
      const skip = Number(url.searchParams.get("$skip") ?? "0");
      const all = Array.from({ length: 350 }, (_, i) => ({ i }));
      return reply(200, { value: all.slice(skip, skip + top) });
    }
    if (rest === "/VOUCHER_HDR('V-77')") return reply(200, { VOUCHER_ID: "V-77", VENDOR_ID: "VND-9" });
    if (rest === "/VENDOR('VND-9')") return reply(200, { VENDOR_ID: "VND-9", NAME: "Acme Steel" });
    return reply(404, { error: { message: `no route ${req.method} ${rest}` } });
  });
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;

const cp = new CostpointClient(parseCostpointCredential(`${base}|cid|sec|user|pw`));

// ---------- integration: auth + paging + crud ----------
const page1 = await cp.query("EMPE", { maxRows: 10_000 });
check("query pages until cap (350 rows over 2 pages)", () => {
  assert.equal(page1.ok, true);
  assert.equal(page1.data.fetched, 350);
  const qs = seen.filter((s) => s.path.endsWith("/EMPE")).map((s) => s.query);
  assert.equal(qs[0].$skip, "0");
  assert.equal(qs[1].$skip, "200");
});
check("OAuth2 token cached across calls", () => {
  assert.equal(tokenRequests, 1);
  const auth = seen.filter((s) => s.path.endsWith("/EMPE"))[0].headers.authorization;
  assert.equal(auth, "Bearer tok1");
});
const rec = await cp.getRecord("PROJECT", "P24-1001");
check("get_record returns ETag and the cached token is reused", () => {
  assert.equal(rec.ok, true, extractCostpointError(rec.data) ?? "");
  assert.equal(rec.etag, 'W/"v3"');
  assert.equal(tokenRequests, 1); // first read used the cached grant
});
check("update_record sends If-Match and JSON patch", async () => {
  const r = await cp.request("PATCH", keyPath("PROJECT", "P24-2002"), { body: { DESCRIPTION: "x" }, headers: { "if-match": 'W/"v3"' } });
  assert.equal(r.ok, true);
  const hit = seen.find((s) => s.path === "/api/v1/PROJECT('P24-2002')");
  assert.equal(hit.headers["if-match"], 'W/"v3"');
  assert.deepEqual(JSON.parse(hit.raw), { DESCRIPTION: "x" });
});
check("error surface: Costpoint error body propagates", async () => {
  const r = await cp.getRecord("PROJECT", "P24-4044");
  assert.equal(extractCostpointError(r.data), "404: no such project");
});
check("batch_upsert continues past failures with per-record results", async () => {
  const c2 = new CostpointClient(parseCostpointCredential(`${base}|cid|sec|user|pw`));
  seen.length = 0;
  const res = await (async () => {
    const out = [];
    for (const k of ["P24-2002", "P24-4044", "P24-2002"]) {
      const r = await patchRecordGuarded(c2, "PROJECT", k, { DESCRIPTION: "y" });
      out.push({ key: k, ok: r.ok });
    }
    return out;
  })();
  assert.deepEqual(res.map((x) => x.ok), [true, false, true]);
  // Every patch is preceded by a read that supplied its ETag.
  assert.deepEqual(
    seen.filter((s) => s.path.startsWith("/api/v1/PROJECT('P24-2002')")).map((s) => s.method),
    ["GET", "PATCH", "GET", "PATCH"],
  );
  assert.equal(seen.some((s) => s.headers["if-match"] === "*"), false);
});
check("labor_entries posts mapped Costpoint fields", async () => {
  const r = await cp.request("POST", "LABOR_ACTUALS", {
    body: { EMPE_ID: "1234", PROJECT_ID: "P24-1001", WORK_DT: "2026-11-27", HOURS: 8, TS_PERIOD: "2026-24" },
  });
  assert.equal(r.ok, true);
  assert.deepEqual(JSON.parse(labors[0]), { EMPE_ID: "1234", PROJECT_ID: "P24-1001", WORK_DT: "2026-11-27", HOURS: 8, TS_PERIOD: "2026-24" });
});
check("metadata returns EDMX XML", async () => {
  const r = await cp.request("GET", "$metadata", { accept: "application/xml" });
  assert.equal(String(r.data).includes("edmx:Edmx"), true);
});
check("project_snapshot chains header + budgets + org", async () => {
  const r = await cp.getRecord("PROJECT", "P24-1001");
  const budgets = await cp.query("PROJECT_BUDGETS", { filter: "PROJECT_ID eq 'P24-1001'", maxRows: 500 });
  assert.equal(r.data.ORG_ID, "100");
  assert.equal(budgets.data.value.length, 350);
});
check("voucher_snapshot chains header + lines + vendor", async () => {
  const h = await cp.getRecord("VOUCHER_HDR", "V-77");
  assert.equal(h.ok, true, extractCostpointError(h.data) ?? "");
  const v = await cp.getRecord("VENDOR", h.data.VENDOR_ID);
  assert.equal(v.data.NAME, "Acme Steel");
});
check("API-key mode sends X-Api-Key and never requests a token", async () => {
  const grants = tokenRequests;
  const c3 = new CostpointClient(parseCostpointCredential(`${base}|key123`));
  await c3.getRecord("PROJECT", "P24-1001");
  const hit = seen.filter((s) => s.path === "/api/v1/PROJECT('P24-1001')").at(-1);
  assert.equal(hit.headers["x-api-key"], "key123");
  assert.equal(tokenRequests, grants);
});

check("401 mid-run refreshes the token once and retries", () => {
  assert.equal(tokenRequests, 3); // cp grant + c2 grant + refresh grant after the 401
});

// ---------- security: guarded writes always carry a real ETag ----------
check("guarded delete reads the ETag first and sends If-Match", async () => {
  const before = seen.length;
  const r = await deleteRecordGuarded(cp, "PROJECT", "P24-7777");
  assert.equal(r.ok, true, r.error ?? "");
  const ops = seen.slice(before).map((s) => s.method);
  assert.deepEqual(ops, ["GET", "DELETE"]);
  const del = seen.slice(before).find((s) => s.method === "DELETE");
  assert.equal(del.headers["if-match"], 'W/"v9"');
});
check("wildcard If-Match is refused for deletes", async () => {
  const before = seen.length;
  const r = await deleteRecordGuarded(cp, "PROJECT", "P24-7777", "*");
  assert.equal(r.ok, false);
  assert.match(r.error, /Wildcard/);
  assert.equal(seen.length, before); // nothing was sent
});
check("delete with no ETag available is refused, not sent unconditionally", async () => {
  const before = seen.length;
  const r = await deleteRecordGuarded(cp, "PROJECT", "P24-8888");
  assert.equal(r.ok, false);
  assert.match(r.error, /No ETag/);
  assert.equal(seen.slice(before).some((s) => s.method === "DELETE"), false);
});
check("guarded patch reads the ETag first and sends If-Match", async () => {
  const before = seen.length;
  const r = await patchRecordGuarded(cp, "PROJECT", "P24-7777", { DESCRIPTION: "y" });
  assert.equal(r.ok, true, r.error ?? "");
  const p = seen.slice(before).find((s) => s.method === "PATCH");
  assert.equal(p.headers["if-match"], 'W/"v9"');
});
check("no request in the suite ever used If-Match: *", () => {
  assert.equal(seen.some((s) => s.headers["if-match"] === "*"), false);
});
chain.then(() => new Promise((r) => server.close(r))).then(() => {
  console.log(`${passed} passed${process.exitCode ? " (with failures)" : ""}`);
});
