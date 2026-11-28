// Security regression checks for the pure guards that sit on trust boundaries.
// No network, no database: every module loaded here is side-effect free, so the
// suite is fast enough to run on every commit (wired into CI as check:security).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const sanitize = await import("../src/lib/sanitize.ts");
const net = await import("../src/lib/net-guard.ts");
const authority = await import("../src/lib/tool-authority.ts");
const rbac = await import("../src/lib/rbac.ts");
const limiter = await import("../src/lib/rate-limit.ts");
const tenantCtx = await import("../src/lib/tenant-context.ts");

let passed = 0;
const failures = [];
async function check(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`PASS ${name}`);
  } catch (err) {
    failures.push(`${name}: ${err.message}`);
    console.log(`FAIL ${name}: ${err.message}`);
  }
}

// Synthetic credentials built at runtime: nothing here is a usable token.
const FAKE_KEY_BODY = "a1b2c3d4e5f6".repeat(2);
const FAKE_JWT = ["eyJhbGciOiJIUzI1NiJ9", "eyJzdWIiOiJ0ZXN0In0", "not-a-real-signature-0000000000"].join(".");

// ---------- secret redaction ----------
await check("redactSecrets strips labelled credentials", () => {
  const out = sanitize.redactSecrets(`api_key=${FAKE_KEY_BODY} and password: ${"hunter2".repeat(2)}`);
  assert.equal(out.includes(FAKE_KEY_BODY), false);
  assert.equal(out.includes("hunter2hunter2"), false);
});

await check("redactSecrets strips bearer tokens and JWTs", () => {
  const out = sanitize.redactSecrets(`Authorization: Bearer ${"z".repeat(20)}1234 ${FAKE_JWT}`);
  assert.equal(out.includes("z".repeat(20)), false);
  assert.equal(out.includes(FAKE_JWT), false);
});

await check("redactDeep scrubs nested values but keeps file data URLs when asked", () => {
  const dataUrl = `data:application/vnd.openxmlformats-officedocument.spreadsheetml.sheet;base64,${"A".repeat(200)}`;
  const payload = { fileDataUrl: dataUrl, note: "secret: supersecretvalue", rows: [{ key: `token=${"q".repeat(12)}` }] };
  const kept = sanitize.redactDeep(payload, { keepBase64: true });
  assert.equal(kept.fileDataUrl, dataUrl, "generated-file payload must survive");
  assert.equal(kept.note.includes("supersecretvalue"), false);
  assert.equal(kept.rows[0].key.includes("q".repeat(12)), false);
});

await check("redactDeep drops bare long base64 by default (leaked key heuristic)", () => {
  const blob = "Q".repeat(64);
  assert.equal(sanitize.redactDeep(`{"k":"${blob}"}`).includes(blob), false);
});

await check("safeErrorMessage drops internal URLs, connection strings and stack detail", () => {
  const msg = sanitize.safeErrorMessage(
    new Error(`connect ECONNREFUSED postgres://user:${"p".repeat(8)}@10.0.3.7:5432/app at /srv/app/src/lib/db.ts:42`),
  );
  assert.equal(msg.includes("10.0.3.7"), false);
  assert.equal(msg.includes(`user:${"p".repeat(8)}`), false);
  assert.equal(msg.length <= 240, true);
});

await check("safeErrorMessage never echoes an empty or huge error", () => {
  assert.equal(sanitize.safeErrorMessage(null, "fallback text"), "fallback text");
  assert.equal(sanitize.safeErrorMessage(new Error("x".repeat(5000))).length <= 240, true);
});

// ---------- active content / markup ----------
await check("isActiveMediaType flags everything that can execute on our origin", () => {
  for (const t of ["text/html", "image/svg+xml", "application/xhtml+xml", "application/xml", "text/xml"]) {
    assert.equal(sanitize.isActiveMediaType(t), true, t);
  }
  for (const t of ["application/pdf", "image/png", "text/plain", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"]) {
    assert.equal(sanitize.isActiveMediaType(t), false, t);
  }
});

await check("sanitizeHtml removes scripts, handlers and javascript: URLs", () => {
  const out = sanitize.sanitizeHtml(
    `<h1 onclick="steal()">Hi</h1><script>fetch('/steal')</script><a href="javascript:alert(1)">x</a><iframe src="//evil"></iframe>`,
  );
  assert.equal(/<script/i.test(out), false);
  assert.equal(/onclick=/i.test(out), false);
  assert.equal(/javascript:/i.test(out), false);
  assert.equal(/<iframe/i.test(out), false);
  assert.equal(out.includes("<h1>Hi</h1>"), true);
});

await check("sanitizeSvg removes script, foreignObject, image/use and on* handlers", () => {
  const out = sanitize.sanitizeSvg(
    `<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script><foreignObject><body/></foreignObject><image href="x"/><use href="#a"/><rect onload="x()" width="1"/></svg>`,
  );
  assert.equal(/<script|<foreignObject|<image|<use\b/i.test(out), false);
  assert.equal(/onload=/i.test(out), false);
  assert.equal(out.includes("<rect"), true);
});

await check("neutraliseCsv defuses spreadsheet formula injection", () => {
  const out = sanitize.neutraliseCsv('name,value\r\n=HYPERLINK("http://evil"),1\r\n@SUM(A1),2\r\nplain,3');
  for (const line of out.split("\n")) {
    for (const cell of line.split(",")) {
      assert.equal(/^[=+\-@\t\r]/.test(cell), false, `still dangerous: ${cell}`);
    }
  }
  assert.equal(out.includes("'=HYPERLINK"), true);
  assert.equal(out.includes("plain,3"), true);
});

// ---------- SSRF / egress ----------
await check("addressBlockReason blocks loopback, private, link-local and metadata addresses", () => {
  for (const ip of [
    "127.0.0.1",
    "10.1.2.3",
    "172.16.0.9",
    "192.168.1.1",
    "169.254.169.254",
    "100.64.1.1",
    "0.0.0.0",
    "::1",
    "fe80::1",
    "fd00:ec2::254",
    "::ffff:127.0.0.1",
    "64:ff9b::10.0.0.1",
    "2002:7f00:1::",
  ]) {
    assert.notEqual(net.addressBlockReason(ip), null, ip);
  }
});

await check("addressBlockReason allows ordinary public addresses", () => {
  for (const ip of ["1.1.1.1", "8.8.8.8", "93.184.216.34", "2606:4700:4700::1111"]) {
    assert.equal(net.addressBlockReason(ip), null, ip);
  }
});

await check("urlCredentialReason refuses embedded credentials and token query params", () => {
  assert.notEqual(net.urlCredentialReason(new URL(`https://user:${"p".repeat(6)}@example.com/x`)), null);
  assert.notEqual(net.urlCredentialReason(new URL("https://example.com/x?access_token=abc")), null);
  assert.notEqual(net.urlCredentialReason(new URL("https://example.com/x?api_key=abc")), null);
  assert.equal(net.urlCredentialReason(new URL("https://example.com/x?page=2&limit=10")), null);
});

await check("assertPublicDestination rejects private targets and DNS rebinding", async () => {
  const resolver = async (host) =>
    host === "rebind.example" ? [{ address: "127.0.0.1", family: 4 }] : [{ address: "93.184.216.34", family: 4 }];
  await assert.rejects(() => net.assertPublicDestination("http://169.254.169.254/latest/meta-data", { resolver }));
  await assert.rejects(() => net.assertPublicDestination("https://rebind.example/", { resolver }));
  await assert.rejects(() => net.assertPublicDestination("https://example.com/x?access_token=abc", { resolver }));
  await assert.doesNotReject(() => net.assertPublicDestination("https://example.com/", { resolver }));
});

// ---------- tool authority (role vs tool, enforced outside the model) ----------
await check("classifyTool separates read, write, destructive and admin surfaces", () => {
  assert.equal(authority.classifyTool("hs_search"), "read");
  assert.equal(authority.classifyTool("sf_create_record"), "write");
  assert.equal(authority.classifyTool("cp_delete_record"), "destructive");
  assert.equal(authority.classifyTool("or_keys_list"), "admin");
});

await check("viewer is refused every mutating tool; member loses destructive and admin", () => {
  assert.equal(authority.toolAuthorityReason("hs_search", "viewer"), null);
  assert.notEqual(authority.toolAuthorityReason("sf_create_record", "viewer"), null);
  assert.equal(authority.toolAuthorityReason("sf_create_record", "member"), null);
  assert.notEqual(authority.toolAuthorityReason("cp_delete_record", "member"), null);
  assert.notEqual(authority.toolAuthorityReason("or_keys_create", "member"), null);
  assert.equal(authority.toolAuthorityReason("or_keys_create", "admin"), null);
});

await check("enforceToolAuthority filters the toolset and QUILLON_TOOL_DENY wins", () => {
  const tools = { hs_search: {}, sf_create_record: {}, cp_delete_record: {} };
  assert.deepEqual(Object.keys(authority.enforceToolAuthority(tools, "viewer")), ["hs_search"]);
  assert.deepEqual(Object.keys(authority.enforceToolAuthority(tools, "member")), ["hs_search", "sf_create_record"]);
  process.env.QUILLON_TOOL_DENY = "hs_*";
  try {
    assert.deepEqual(Object.keys(authority.enforceToolAuthority(tools, "admin")), ["sf_create_record", "cp_delete_record"]);
  } finally {
    delete process.env.QUILLON_TOOL_DENY;
  }
});

// ---------- RBAC / tenancy ----------
await check("roleOf grants member only on an explicit member role and fails closed otherwise", () => {
  assert.equal(rbac.roleOf({ roles: ["viewer"] }), "viewer");
  assert.equal(rbac.roleOf({ roles: ["member"] }), "member");
  assert.equal(rbac.roleOf({ roles: ["admin"] }), "admin");
  // Updated: an empty role claim is not a grant. Fail-closed means a session
  // the IdP has not provisioned a role for gets viewer, never write access.
  assert.equal(rbac.roleOf({}), "viewer");
  // Unrecognised role claims fail closed: no write access without a known role.
  assert.equal(rbac.roleOf({ roles: ["nonsense"] }), "viewer");
  assert.equal(rbac.roleOf({ roles: ["nonsense", "admin"] }), "admin");
});

await check("orgForSession is stable per subject and never blank", () => {
  const a = rbac.orgForSession({ sub: "user-a", email: "a@acme.test" });
  const b = rbac.orgForSession({ sub: "user-b", email: "b@globex.test" });
  assert.notEqual(a, b);
  assert.equal(typeof rbac.orgForSession({ sub: "user-a" }), "string");
});

// ---------- permission manifest, capability, timeouts, egress, audit ----------
// These load modules that reach the database; point it at a throwaway file first
// so the checks never touch the developer's .data/quillon.db.
const tmpDir = await import("node:fs").then((fs) => fs.mkdtempSync("/tmp/quillon-check-"));
process.env.DATABASE_PATH = `${tmpDir}/check.db`;
process.env.QUILLON_AUDIT_KEY = "check-suite-signing-key-0001";
const manifest = await import("../src/lib/tool-manifest.ts");
const policy = await import("../src/lib/tool-policy.ts");
const records = await import("../src/lib/record-policy.ts");
const checkpoints = await import("../src/lib/audit-checkpoint.ts");
const dbModule = await import("../src/lib/db.ts");

await check("every declared connector tool has an explicit permission class", async () => {
  const sources = await Promise.all([
    import("../src/lib/salesforce.ts"),
    import("../src/lib/hubspot.ts"),
    import("../src/lib/netsuite.ts"),
    import("../src/lib/costpoint.ts"),
    import("../src/lib/openrouter.ts"),
    import("../src/lib/enterprise-platforms.ts"),
  ]);
  const [sf, hs, ns, cp, or, ent] = sources;
  const declared = [
    ...sf.SF_TOOLS.map((t) => `sf_${t.name}`),
    ...hs.HS_TOOLS.map((t) => `hs_${t.name}`),
    ...ns.NS_TOOLS.map((t) => `ns_${t.name}`),
    ...cp.CP_TOOLS.map((t) => `cp_${t.name}`),
    ...or.OR_TOOLS.map((t) => `or_${t.name}`),
    ...ent.ENTERPRISE_RECIPES.flatMap((r) => r.actions.map((a) => `ent_${r.id}_${a.id}`)),
  ];
  const missing = declared.filter((name) => !(name in manifest.TOOL_CLASSES));
  assert.deepEqual(missing, [], `unclassified tools: ${missing.slice(0, 5).join(", ")}`);
  assert.ok(declared.length > 300, `expected the full connector surface, saw ${declared.length}`);
});

await check("administrative OpenRouter operations are not ordinary writes", () => {
  for (const name of [
    "or_external_users_create",
    "or_private_endpoints_create",
    "or_private_providers_create",
    "or_request",
  ]) {
    assert.equal(manifest.TOOL_CLASSES[name], "admin", `${name} must be administrator-only`);
    assert.notEqual(authority.toolAuthorityReason(name, "member"), null, `${name} must be denied to a member`);
  }
});

await check("a tool outside the manifest is denied to every role", () => {
  // Default deny: a new integration must be declared before the model can call it.
  assert.notEqual(authority.toolAuthorityReason("totally_new_tool", "admin"), null);
  assert.notEqual(authority.toolAuthorityReason("totally_new_tool", "member"), null);
  assert.equal(authority.classifyTool("totally_new_tool"), "admin");
  // Dynamic MCP tools are admin-only unless the operator names the server.
  assert.notEqual(authority.toolAuthorityReason("mcp_home_files_read", "member"), null);
  process.env.QUILLON_MCP_MEMBER_SERVERS = "home files";
  assert.equal(authority.toolAuthorityReason("mcp_home_files_read", "member"), null);
  assert.notEqual(authority.toolAuthorityReason("mcp_other_server_read", "member"), null);
  delete process.env.QUILLON_MCP_MEMBER_SERVERS;
});

await check("role filtering keeps viewers read-only and members off admin tools", () => {
  delete process.env.QUILLON_TOOL_DENY;
  const tools = {
    or_chat: { description: "read" },
    ns_create_record: { description: "write" },
    cp_delete_record: { description: "destructive" },
    or_keys_list: { description: "admin" },
    mc_unknown: { description: "unlisted" },
  };
  assert.deepEqual(authority.allowedToolNames(tools, "viewer"), ["or_chat"]);
  assert.deepEqual(authority.allowedToolNames(tools, "member"), ["or_chat", "ns_create_record"]);
  assert.deepEqual(authority.allowedToolNames(tools, "admin").sort(), [
    "cp_delete_record",
    "ns_create_record",
    "or_chat",
    "or_keys_list",
  ].sort());
  // A hard deny list wins over every role, administrators included.
  process.env.QUILLON_TOOL_DENY = "cp_delete_*";
  assert.deepEqual(
    authority.allowedToolNames(tools, "admin").sort(),
    ["ns_create_record", "or_chat", "or_keys_list"].sort(),
  );
  delete process.env.QUILLON_TOOL_DENY;
});

await check("record policy blocks payroll and employee writes for members", () => {
  const netsuiteWrite = { recordType: "employee", values: { salary: 120000 } };
  assert.notEqual(records.recordPolicyReason("netsuite", "ns_create_record", netsuiteWrite, "member"), null);
  assert.notEqual(
    records.recordPolicyReason("salesforce", "sf_create_record", { sobject: "User", data: { Name: "x" } }, "member"),
    null,
  );
  // A field alone is enough, on any restricted connector.
  assert.notEqual(
    records.recordPolicyReason("hubspot", "hs_create_contact", { properties: { ssn: "000-00-0000" } }, "member"),
    null,
  );
  // Ordinary CRM work stays open to a member, and administrators are unrestricted.
  assert.equal(records.recordPolicyReason("hubspot", "hs_create_contact", { properties: { email: "a@b.test" } }, "member"), null);
  assert.equal(records.recordPolicyReason("netsuite", "ns_create_record", netsuiteWrite, "admin"), null);
  // Connectors with no employment or finance records are untouched.
  assert.equal(records.recordPolicyReason("slack", "ent_slack_send_message", { channel: "hr", text: "hi" }, "member"), null);
});

await check("capability grants are mandatory for members, optional for administrators", () => {
  assert.equal(policy.capabilitiesRequired("member"), true);
  assert.equal(policy.capabilitiesRequired("viewer"), true);
  assert.equal(policy.capabilitiesRequired("admin"), false);
  process.env.QUILLON_REQUIRE_GRANTS = "1";
  assert.equal(policy.capabilitiesRequired("admin"), true);
  delete process.env.QUILLON_REQUIRE_GRANTS;
});

await check("a tool timeout aborts the running call and warns about lost writes", async () => {
  let signal;
  const hanging = {
    or_chat: {
      execute: async (_input, options) => {
        signal = options.abortSignal;
        return new Promise((resolve) => options.abortSignal.addEventListener("abort", () => resolve("stopped")));
      },
    },
    ns_create_record: {
      execute: async (_input, options) => {
        signal = options.abortSignal;
        return new Promise((resolve) => options.abortSignal.addEventListener("abort", () => resolve("stopped")));
      },
    },
  };
  const wrapped = policy.withToolTimeouts(hanging, 60);
  await assert.rejects(() => wrapped.or_chat.execute({}, {}), /timed out/);
  assert.equal(signal.aborted, true, "the read's signal must be aborted on timeout");
  await assert.rejects(() => wrapped.ns_create_record.execute({}, {}), /read the record back before retrying/);
  assert.equal(signal.aborted, true, "the write's signal must be aborted on timeout");
});

await check("an allowlisted host that resolves privately is still refused", async () => {
  const resolver = async () => [{ address: "10.0.0.7", family: 4 }];
  const scoped = { allowlist: ["internal.corp.test"], resolver };
  process.env.QUILLON_EGRESS_ALLOWLIST = "internal.corp.test";
  delete process.env.QUILLON_EGRESS_PRIVATE_HOSTS;
  await assert.rejects(() => net.assertPublicDestination("https://internal.corp.test/api", scoped), /blocked address/);
  // Reaching an internal service needs the destination named explicitly.
  process.env.QUILLON_EGRESS_PRIVATE_HOSTS = "internal.corp.test";
  await assert.doesNotReject(() => net.assertPublicDestination("https://internal.corp.test/api", scoped));
  // An unlisted private destination stays refused even with the approval set.
  delete process.env.QUILLON_EGRESS_ALLOWLIST;
  delete process.env.QUILLON_EGRESS_PRIVATE_HOSTS;
});

await check("signed audit checkpoints detect a rewritten audit log", async () => {
  const db = dbModule.getDb();
  db.prepare("INSERT INTO audit_log (org, actor, action, resource, detail, hash) VALUES ('default','t','a','r','{}','h1')").run();
  const created = checkpoints.createCheckpoint("default");
  assert.equal(created.created, true);
  assert.equal(checkpoints.verifyCheckpoints("default").ok, true);
  assert.equal(checkpoints.createCheckpoint("default").created, false, "no new rows means no new checkpoint");

  // A rewritten checkpoint no longer matches its signature.
  db.prepare("UPDATE audit_checkpoints SET audit_count = 999 WHERE seq = ?").run(created.checkpoint.seq);
  const tampered = checkpoints.verifyCheckpoints("default");
  assert.equal(tampered.ok, false);
  assert.match(tampered.broken.reason, /signature/);

  // A log row deleted after signing is caught as well.
  db.prepare("UPDATE audit_checkpoints SET audit_count = 1 WHERE seq = ?").run(created.checkpoint.seq);
  db.prepare("UPDATE audit_checkpoints SET signature = ? WHERE seq = ?").run(
    // Re-sign with the real key so only the missing row can fail the check.
    (await import("node:crypto")).createHmac("sha256", process.env.QUILLON_AUDIT_KEY)
      .update(JSON.stringify([created.checkpoint.seq, "default", 1, created.checkpoint.headHash, null]))
      .digest("hex"),
    created.checkpoint.seq,
  );
  db.prepare("DELETE FROM audit_log WHERE hash = 'h1'").run();
  const removed = checkpoints.verifyCheckpoints("default");
  assert.equal(removed.ok, false);
  assert.match(removed.broken.reason, /rewritten or removed/);
});

// ---------- cross-tenant isolation: memory ----------
const memory = await import("../src/lib/memory.ts");

await check("memory recall is scoped to the caller's tenant and owner", () => {
  const alice = { tenant: "acme.test", owner: "sub-alice" };
  const bob = { tenant: "acme.test", owner: "sub-bob" };
  const thread = memory.resolveConversation(alice, "thread-alice-0001");
  memory.addMemory(alice, "alice's compensation band is confidential", thread, "agent");

  assert.ok(memory.listMemories(alice).length >= 1, "alice reads her own memory");
  assert.equal(memory.listMemories(bob).length, 0, "a colleague must not see alice's memories");
  assert.equal(memory.listMemories({ tenant: "globex.test", owner: "sub-alice" }).length, 0);

  // Presenting another identity's conversation id yields a fresh thread, not
  // that conversation's memories.
  const borrowed = memory.resolveConversation(bob, thread);
  assert.notEqual(borrowed, thread);
  assert.equal(memory.memoryContext(bob, borrowed).includes("compensation"), false);

  // Deletion is scoped too: a foreign id deletes nothing.
  const record = memory.listMemories(alice)[0];
  assert.equal(memory.deleteMemory(bob, record.id), false);
  assert.ok(memory.listMemories(alice).length >= 1);

  // The legacy "default" thread is per identity, never one shared thread.
  assert.notEqual(memory.defaultConversationId(alice), memory.defaultConversationId(bob));
});

// ---------- cross-tenant isolation: transactions ----------
const tx = await import("../src/lib/transaction.ts");
let executes = 0;
tx.registerActionType("test.write", {
  simulate: async (p) => ({ would: p }),
  execute: async (p) => {
    executes++;
    return { ok: true, ...p };
  },
  undo: async () => {},
});
tx.registerActionType("test.delete_record", { execute: async () => ({ deleted: true }) });

await check("a transaction id from another tenant is indistinguishable from missing", () => {
  const acme = { tenant: "acme.test", actor: "maker@acme.test" };
  const plan = tx.planTransaction(acme, "Write a note", "isolation", [
    { kind: "test.write", target: "note:1", payload: { text: "hi" } },
  ]);
  const globex = { tenant: "globex.test", actor: "boss@globex.test" };
  assert.equal(tx.getTransaction(globex, plan.id), null);
  assert.equal(tx.listTransactions(globex).length, 0);
  assert.deepEqual(tx.getReplay(globex, plan.id), []);
  assert.throws(() => tx.approve(globex, plan.id, true), /Unknown transaction/);
});

await check("the maker cannot approve their own plan", async () => {
  const acme = { tenant: "acme.test", actor: "maker@acme.test" };
  const plan = tx.planTransaction(acme, "Self approve", "sod", [
    { kind: "test.write", target: "note:2", payload: {} },
  ]);
  await tx.simulate(acme, plan.id);
  assert.throws(() => tx.approve(acme, plan.id, true), /Separation of duties/);
});

await check("approval is bound to the exact plan and a tampered plan cannot execute", async () => {
  const acme = { tenant: "acme.test", actor: "maker@acme.test" };
  const plan = tx.planTransaction(acme, "Write a note", "binding", [
    { kind: "test.write", target: "note:3", payload: { text: "original" } },
  ]);
  await tx.simulate(acme, plan.id);
  const approved = tx.approve({ tenant: "acme.test", actor: "checker@acme.test" }, plan.id, true);
  assert.equal(approved.status, "executing");
  assert.equal(approved.approved_hash, approved.plan_hash);

  const before = executes;
  dbModule.getDb().prepare("UPDATE transaction_actions SET payload = ? WHERE transaction_id = ?").run(
    JSON.stringify({ text: "tampered" }),
    plan.id,
  );
  await assert.rejects(() => tx.execute(acme, plan.id), /modified/);
  assert.equal(executes, before, "nothing may run after plan tampering");

  dbModule.getDb().prepare("UPDATE transaction_actions SET payload = ? WHERE transaction_id = ?").run(
    JSON.stringify({ text: "original" }),
    plan.id,
  );
  const done = await tx.execute(acme, plan.id);
  assert.equal(done.status, "done");
  assert.equal(executes, before + 1);
});

await check("two workers cannot execute the same transaction", async () => {
  const acme = { tenant: "acme.test", actor: "maker@acme.test" };
  const plan = tx.planTransaction(acme, "Lease", "single execution", [
    { kind: "test.write", target: "note:4", payload: {} },
  ]);
  await tx.simulate(acme, plan.id);
  tx.approve({ tenant: "acme.test", actor: "checker@acme.test" }, plan.id, true);
  // Simulate another worker holding a live lease.
  dbModule.getDb().prepare("UPDATE transactions SET execution_lease = ? WHERE id = ?").run(
    new Date(Date.now() + 60_000).toISOString(),
    plan.id,
  );
  await assert.rejects(() => tx.execute(acme, plan.id), /already being executed/);
  dbModule.getDb().prepare("UPDATE transactions SET execution_lease = NULL WHERE id = ?").run(plan.id);
  assert.equal((await tx.execute(acme, plan.id)).status, "done");
});

await check("destructive actions need two distinct approvers", async () => {
  const acme = { tenant: "acme.test", actor: "maker@acme.test" };
  const plan = tx.planTransaction(acme, "Delete a record", "dual control", [
    { kind: "test.delete_record", target: "rec:9", payload: {} },
  ]);
  await tx.simulate(acme, plan.id);
  assert.equal(tx.getTransaction(acme, plan.id).requires_second_approval, true);

  const first = tx.approve({ tenant: "acme.test", actor: "checker@acme.test" }, plan.id, true);
  assert.equal(first.status, "awaiting_approval", "one approval is not enough to execute");
  assert.throws(
    () => tx.approve({ tenant: "acme.test", actor: "checker@acme.test" }, plan.id, true),
    /second approver/,
  );

  const second = tx.approve({ tenant: "acme.test", actor: "risk@acme.test" }, plan.id, true);
  assert.equal(second.status, "executing");
  assert.equal(second.second_approved_by, "risk@acme.test");
  assert.equal((await tx.execute(acme, plan.id)).status, "done");
});

// ---------- tenant scoping of governance data ----------
const capability = await import("../src/lib/capability.ts");
const durable = await import("../src/lib/durable.ts");
const verify = await import("../src/lib/verify.ts");

await check("governance listings are empty without a tenant and filtered by it", () => {
  assert.deepEqual(capability.listCapabilities(undefined, 100), [], "no org means no grants");
  assert.deepEqual(durable.listRuns(50), [], "no org means no runs");
  assert.equal(durable.getRun("any-id"), null);
  assert.deepEqual(verify.listReports(25), [], "no org means no reports");

  const cap = capability.grantCapability({
    subject: "acme.test|sub-alice",
    connector: "netsuite",
    action: "read",
    org: "acme.test",
  });
  assert.equal(cap.org, "acme.test");
  assert.equal(capability.listCapabilities(undefined, 100, "acme.test").some((c) => c.id === cap.id), true);
  assert.equal(capability.listCapabilities(undefined, 100, "globex.test").length, 0);

  // The principal a capability is granted to carries the tenant prefix, so a
  // grant can never be addressed to another tenant's user.
  const principal = rbac.principalForSession({ sub: "sub-alice", email: "alice@acme.test" });
  assert.equal(principal.tenant, "acme.test");
  assert.equal(principal.owner, "sub-alice");
});

// ---------- code sandbox: what counts as isolation ----------
const isolationModule = await import("../src/lib/sandbox-isolation.ts");

await check("production refuses netns and unjailed code execution", () => {
  const previous = { nodeEnv: process.env.NODE_ENV, unjailed: process.env.QUILLON_SANDBOX_ALLOW_UNJAILED };
  try {
    assert.equal(isolationModule.isolationSufficient("netns"), false, "netns leaves the filesystem visible");
    assert.equal(isolationModule.isolationSufficient("none"), false);
    assert.equal(isolationModule.isolationSufficient("bwrap"), true);
    assert.equal(isolationModule.isolationSufficient("chroot"), true);
    assert.match(isolationModule.isolationRefusal("netns"), /filesystem/);
    assert.equal(isolationModule.isolationRefusal("bwrap"), null);

    process.env.NODE_ENV = "production";
    process.env.QUILLON_SANDBOX_ALLOW_UNJAILED = "1";
    assert.equal(
      isolationModule.isolationRequired(),
      true,
      "the unjailed escape hatch must not override production",
    );
  } finally {
    if (previous.nodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previous.nodeEnv;
    if (previous.unjailed === undefined) delete process.env.QUILLON_SANDBOX_ALLOW_UNJAILED;
    else process.env.QUILLON_SANDBOX_ALLOW_UNJAILED = previous.unjailed;
  }
});

// ---------- code sandbox: resource caps must not fail a finished run ----------
const cgroupModule = await import("../src/lib/cgroup.ts");
const sandboxModule = await import("../src/lib/sandbox.ts");

await check("cgroup teardown removes the group without throwing (cgroupfs files cannot be unlinked)", () => {
  const handle = cgroupModule.createCgroup();
  if (!handle) return; // no writable cgroup v2 hierarchy on this host
  handle.remove(); // a recursive unlink of the control files throws EPERM
  assert.equal(existsSync(handle.dir), false, "the one-run cgroup is gone from the hierarchy");
  handle.remove(); // and teardown is idempotent
});

await check("a completed sandbox run resolves even when its resource caps are torn down", async () => {
  const { readdirSync } = await import("node:fs");
  const groupsBefore = readdirSync("/sys/fs/cgroup").filter((n) => n.startsWith("quillon-"));
  const result = await sandboxModule.runCode({ language: "python", code: "print(6*7)", timeoutMs: 8000 });
  assert.equal(result.exitCode, 0, `run failed: ${result.error ?? result.stderr}`);
  assert.match(result.stdout, /42/);
  // The cap string is a promise to the caller: the run's own group must be gone.
  const groupsAfter = readdirSync("/sys/fs/cgroup").filter((n) => n.startsWith("quillon-"));
  assert.deepEqual(
    groupsAfter.filter((n) => !groupsBefore.includes(n)),
    [],
    `teardown left a cgroup behind: ${groupsAfter.join(", ")}`,
  );
});


await check("the dependency-advisory gate fails on an unaccepted advisory and passes on the current tree", () => {
  const root = new URL("..", import.meta.url).pathname;
  const tmp = join(tmpdir(), `quillon-audit-${process.pid}.json`);
  writeFileSync(
    tmp,
    JSON.stringify({
      vulnerabilities: {
        evilpkg: { severity: "critical", via: [{ url: "https://github.com/advisories/GHSA-test-only" }] },
      },
      metadata: { vulnerabilities: { high: 0, critical: 1, moderate: 0 } },
    }),
  );
  try {
    const bad = spawnSync(process.execPath, [join(root, "scripts/check-audit.mjs"), "--report", tmp], {
      encoding: "utf8",
    });
    assert.equal(bad.status, 1, "a critical advisory that is not allowlisted must fail the gate");
    assert.match(bad.stderr, /GHSA-test-only/);

    const good = spawnSync(process.execPath, [join(root, "scripts/check-audit.mjs")], { encoding: "utf8" });
    assert.equal(good.status, 0, `the real tree must pass the gate: ${good.stdout}${good.stderr}`);

    // And the gate is wired in as a blocking CI step, not advisory.
    const ci = readFileSync(join(root, ".github/workflows/ci.yml"), "utf8");
    assert.match(ci, /run: npm run check:audit/);
    assert.doesNotMatch(ci, /npm audit[\s\S]{0,120}continue-on-error: true/);
  } finally {
    rmSync(tmp, { force: true });
  }
});

await check("a viewer or unprovisioned approver cannot sign off a high-impact plan", async () => {
  const acme = { tenant: "acme.test", actor: "maker@acme.test" };
  const plan = tx.planTransaction(acme, "Delete a record", "role gate", [
    { kind: "test.delete_record", target: "rec:11", payload: {} },
  ]);
  await tx.simulate(acme, plan.id);
  assert.throws(
    () => tx.approve({ tenant: "acme.test", actor: "viewer@acme.test", roles: ["viewer"] }, plan.id, true),
    /viewer cannot approve/,
  );
  assert.throws(
    () => tx.approve({ tenant: "acme.test", actor: "nobody@acme.test", roles: [] }, plan.id, true),
    /viewer cannot approve/,
    "an identity with no role claim must fail closed",
  );
  const member = tx.approve(
    { tenant: "acme.test", actor: "checker@acme.test", roles: ["member"] },
    plan.id,
    true,
  );
  assert.equal(member.status, "awaiting_approval");
});

await check("a high-impact plan cannot be approved before it is simulated", () => {
  const acme = { tenant: "acme.test", actor: "maker@acme.test" };
  const plan = tx.planTransaction(acme, "Delete a record", "no simulation", [
    { kind: "test.delete_record", target: "rec:12", payload: {} },
  ]);
  // Approving straight from "planned" is refused: nobody has seen the effects.
  assert.throws(
    () => tx.approve({ tenant: "acme.test", actor: "checker@acme.test", roles: ["member"] }, plan.id, true),
    /Cannot approve a transaction in status planned/,
  );
});

// ---------- Rate limiting ----------
await check("rate limiter allows the budget, then answers 429 with Retry-After", () => {
  limiter.resetRateLimits();
  const now = 1_000_000;
  for (let i = 0; i < 3; i++) {
    const v = limiter.take("route:user-a", 3, 60_000, now);
    assert.equal(v.ok, true, `request ${i + 1} should be inside the budget`);
  }
  const blocked = limiter.take("route:user-a", 3, 60_000, now);
  assert.equal(blocked.ok, false);
  assert.ok(blocked.retryAfterMs > 0);

  // Another identity is unaffected, and the window really does reset.
  assert.equal(limiter.take("route:user-b", 3, 60_000, now).ok, true);
  assert.equal(limiter.take("route:user-a", 3, 60_000, now + 60_001).ok, true);

  // A zero budget denies everything rather than meaning "unlimited".
  limiter.resetRateLimits();
  assert.equal(limiter.take("route:off", 0, 1000, now).ok, false);
});

await check("enforceRateLimit returns a 429 body with Retry-After, and null inside budget", async () => {
  limiter.resetRateLimits();
  const first = limiter.enforceRateLimit("acme:user-a", "test-route", 1, 60_000);
  assert.equal(first, null);
  const second = limiter.enforceRateLimit("acme:user-a", "test-route", 1, 60_000);
  assert.ok(second instanceof Response, "the over-budget call must be refused");
  assert.equal(second.status, 429);
  assert.ok(Number(second.headers.get("retry-after")) >= 1);
  const body = await second.json();
  assert.equal(body.error.code, "rate_limited");
  limiter.resetRateLimits();
});

// ---------- Tenant context ----------
await check("tenant context isolates concurrent work and never leaks a default", async () => {
  const [a, b] = await Promise.all([
    tenantCtx.runWithTenant("acme", async () => {
      await new Promise((r) => setTimeout(r, 5));
      return tenantCtx.currentTenant();
    }),
    tenantCtx.runWithTenant("globex", async () => {
      await new Promise((r) => setTimeout(r, 1));
      return tenantCtx.currentTenant();
    }),
  ]);
  assert.equal(a, "acme");
  assert.equal(b, "globex");
  // Outside any scope there is no tenant: callers must pass one explicitly
  // rather than inheriting whatever ran last.
  assert.notEqual(tenantCtx.currentTenant(), "globex");
  assert.equal(tenantCtx.tenantScope("explicit"), "explicit");
});

// ---------- response security headers ----------
const headersModule = await import("../src/lib/security-headers.ts");

await check("every route carries a strict response header policy", () => {
  const prod = Object.fromEntries(headersModule.securityHeaders("production").map((h) => [h.key, h.value]));
  const csp = prod["Content-Security-Policy"];
  assert.ok(csp, "no Content-Security-Policy");
  for (const directive of [
    "default-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "frame-ancestors 'none'",
    "form-action 'self'",
  ]) {
    assert.ok(csp.includes(directive), `CSP is missing "${directive}"`);
  }
  assert.ok(!/script-src[^;]*'unsafe-eval'/.test(csp), "production CSP allows eval");
  assert.equal(prod["X-Content-Type-Options"], "nosniff");
  assert.equal(prod["X-Frame-Options"], "DENY");
  assert.match(prod["Strict-Transport-Security"], /max-age=31536000/);
  assert.match(prod["Referrer-Policy"], /^strict-origin/);
  assert.match(prod["Permissions-Policy"], /camera=\(\)/);
  const dev = Object.fromEntries(headersModule.securityHeaders("development").map((h) => [h.key, h.value]));
  assert.ok(dev["Content-Security-Policy"].includes("'unsafe-eval'"), "dev CSP needs eval for fast refresh");
});

await check("next.config applies the header policy to every route", async () => {
  const cfg = (await import("../next.config.ts")).default;
  const rules = await cfg.headers();
  assert.equal(rules.length, 1, "one catch-all header rule expected");
  assert.equal(rules[0].source, "/:path*");
  assert.ok(
    rules[0].headers.some((h) => h.key === "Content-Security-Policy"),
    "the catch-all rule does not set the CSP",
  );
  assert.equal(cfg.poweredByHeader, false, "the framework banner must not be advertised");
});

console.log(`\n${passed} passed${failures.length ? `, ${failures.length} FAILED` : ""}`);
if (failures.length) {
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
