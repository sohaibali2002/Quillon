// Exercises the deep Salesforce integration against a local mock org that
// implements the official endpoints: token refresh, 401 retry, SOQL queryMore
// pagination, composite, and Bulk API 2.0 ingest. No live org needed.
import { register } from "node:module";
register("./ts-resolve.mjs", import.meta.url);
import assert from "node:assert/strict";

// The mock org listens on loopback; app flow only because the operator
// (this check) names the destination in both egress settings.
process.env.QUILLON_EGRESS_ALLOWLIST = "127.0.0.1";
process.env.QUILLON_EGRESS_PRIVATE_HOSTS = "127.0.0.1";

const { SfClient, parseCredential, extractSfError, csvRows } = await import("../src/lib/salesforce.ts");

const state = { refreshes: 0 };

function respond(res, code, body) {
  res.writeHead(code, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

const server = (await import("node:http")).createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
    if (url.pathname === "/services/oauth2/token") {
      state.refreshes++;
      const form = new URLSearchParams(raw);
      assert.equal(form.get("grant_type"), "refresh_token");
      respond(res, 200, { access_token: `tok-${state.refreshes}`, instance_url: `http://${req.headers.host}` });
      return;
    }
    if (url.pathname === "/services/data/v60.0/query") {
      // Two pages: first returns nextRecordsUrl, second completes.
      if (!url.searchParams.get("page")) {
        respond(res, 200, {
          done: false,
          totalSize: 3,
          records: [{ Id: "1", attributes: {} }, { Id: "2", attributes: {} }],
          nextRecordsUrl: `/services/data/v60.0/query?page=2`,
        });
      } else {
        respond(res, 200, { done: true, totalSize: 3, records: [{ Id: "3", attributes: {} }] });
      }
      return;
    }
    if (url.pathname === "/services/data/v60.0/protected" ) {
      // First call (stale token) 401s, retry succeeds.
      const auth = req.headers.authorization ?? "";
      if (auth.endsWith("tok-1") || !auth.includes(`tok-${state.refreshes}`) || state.refreshes < 2) {
        respond(res, 401, [{ message: "Session expired or invalid", errorCode: "INVALID_SESSION_ID" }]);
      } else {
        respond(res, 200, { fine: true });
      }
      return;
    }
    if (url.pathname === "/services/data/v60.0/composite") {
      const body = JSON.parse(raw);
      assert.equal(body.allOrNone, true);
      assert.equal(body.compositeRequest.length, 2);
      respond(res, 200, { compositeResponse: body.compositeRequest.map((s) => ({ referenceId: s.referenceId, body: { id: "new" } })) });
      return;
    }
    if (url.pathname === "/services/data/v60.0/jobs/ingest" && req.method === "POST") {
      const body = JSON.parse(raw);
      assert.equal(body.contentType, "CSV");
      assert.equal(body.externalIdFieldName, "Ext_Id__c");
      respond(res, 200, { id: "job1", state: "Open" });
      return;
    }
    if (url.pathname === "/services/data/v60.0/jobs/ingest/job1/batches") {
      assert.match(req.headers["content-type"] ?? "", /text\/csv/);
      assert.match(raw, /^Name,Industry\r\n"Name, Ltd",Tech\r\n$/);
      res.writeHead(201).end();
      return;
    }
    if (url.pathname === "/services/data/v60.0/jobs/ingest/job1" && req.method === "PATCH") {
      respond(res, 200, { id: "job1", state: "UploadComplete" });
      return;
    }
    if (url.pathname === "/services/data/v60.0/limits") {
      respond(res, 200, { DailyApiRequests: { Max: 100, Remaining: 99 } });
      return;
    }
    respond(res, 404, [{ message: "not found", errorCode: "NOT_FOUND" }]);
  });
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;

// Unit: pure helpers
assert.equal(parseCredential("https://a.my.salesforce.com|tok").kind, "session");
assert.equal(parseCredential("https://login.salesforce.com|rt|cid|csec").kind, "refresh");
assert.equal(parseCredential("garbage"), null);
assert.equal(extractSfError([{ message: "bad field", errorCode: "INVALID_FIELD" }]), "INVALID_FIELD: bad field");
assert.equal(extractSfError({ error_description: "nope" }), "nope");
const csv = csvRows(["Name", "Industry"], [{ Name: "Name, Ltd", Industry: "Tech" }]);
assert.equal(csv, "Name,Industry\r\n\"Name, Ltd\",Tech\r\n");
console.log("PASS helpers: credential parse, error extract, RFC4180 csv");

const rcred = { kind: "refresh", loginUrl: base, refreshToken: "rt", clientId: "cid", clientSecret: "csec" };
const sf = new SfClient(rcred);

// queryMore pagination across pages
const q = await sf.queryAll("SELECT Id FROM Account");
assert.equal(q.ok, true);
assert.deepEqual(q.data.records.map((r) => r.Id), ["1", "2", "3"]);
assert.equal(q.data.done, true);
assert.equal(q.data.fetched, 3);
console.log("PASS soql_query: followed nextRecordsUrl across 2 pages, 3 rows");

// 401 -> refresh -> retry once
const before = state.refreshes;
const prot = await sf.request("GET", "protected");
assert.equal(prot.ok, true, JSON.stringify(prot));
assert.equal(state.refreshes, before + 1);
console.log("PASS session recovery: 401 refreshed the token and retried");

// composite
const comp = await sf.request("POST", "composite", { body: { allOrNone: true, compositeRequest: [{ method: "POST", url: "sobjects/Account", referenceId: "a", body: { Name: "A" } }, { method: "GET", url: "sobjects/Account/@{a.Id}", referenceId: "b" }] } });
assert.equal(comp.ok, true);
assert.equal(comp.data.compositeResponse.length, 2);
console.log("PASS composite: 2 referenceId-linked sub-requests");

// Bulk API 2.0 ingest lifecycle
const job = await sf.createIngestJob({ operation: "upsert", sobject: "Account", externalIdField: "Ext_Id__c" });
assert.equal(job.data.id, "job1");
const up = await sf.uploadIngestBatch("job1", csv);
assert.equal(up.ok, true);
const closed = await sf.closeIngestJob("job1");
assert.equal(closed.data.state, "UploadComplete");
console.log("PASS bulk ingest: create -> CSV upload -> UploadComplete");

const lim = await sf.request("GET", "limits");
assert.equal(lim.data.DailyApiRequests.Remaining, 99);
console.log("PASS limits");

server.close();
console.log("salesforce check: all assertions passed");
process.exit(0);
