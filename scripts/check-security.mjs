// Security regression checks for the pure guards that sit on trust boundaries.
// No network, no database: every module loaded here is side-effect free, so the
// suite is fast enough to run on every commit (wired into CI as check:security).
import assert from "node:assert/strict";

const sanitize = await import("../src/lib/sanitize.ts");
const net = await import("../src/lib/net-guard.ts");
const authority = await import("../src/lib/tool-authority.ts");
const rbac = await import("../src/lib/rbac.ts");

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
await check("roleOf maps unknown roles to viewer and empty roles to member", () => {
  assert.equal(rbac.roleOf({ roles: ["viewer"] }), "viewer");
  assert.equal(rbac.roleOf({}), "member");
  assert.equal(rbac.roleOf({ roles: ["admin"] }), "admin");
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

console.log(`\n${passed} passed${failures.length ? `, ${failures.length} FAILED` : ""}`);
if (failures.length) {
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
