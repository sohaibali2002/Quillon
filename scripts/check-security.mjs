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

console.log(`\n${passed} passed${failures.length ? `, ${failures.length} FAILED` : ""}`);
if (failures.length) {
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
