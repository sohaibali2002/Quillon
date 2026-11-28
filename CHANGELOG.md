# Changelog

## 2026-11-28 (response hardening, honest resource caps)

- Every response now carries a strict security header policy, defined once in
  `src/lib/security-headers.ts` and applied to `/:path*` from `next.config.ts`:
  CSP (`default-src 'self'`, `object-src 'none'`, `frame-ancestors 'none'`,
  `base-uri`/`form-action 'self'`), HSTS, `nosniff`, `X-Frame-Options: DENY`,
  `Referrer-Policy`, a `Permissions-Policy` that denies camera, microphone,
  geolocation, USB and payment, plus COOP/CORP and
  `X-Permitted-Cross-Domain-Policies: none`. Only response headers changed, so
  the page keeps working (`'unsafe-inline'` stays because App Router emits
  inline bootstrap scripts and styles; `'unsafe-eval'` is development-only).
  `poweredByHeader: false` stops advertising the framework. Verified on a live
  `next start`: `curl -I` shows the full set.
- Sandbox resource caps tear down without failing a finished run. cgroupfs
  control files cannot be unlinked, so the recursive `rmSync` in
  `src/lib/cgroup.ts` threw `EPERM` after a run had already produced its result,
  and left the group behind. Teardown now writes `cgroup.kill`, `rmdir`s the
  group and never throws. `src/lib/sandbox.ts` also stops claiming a cap the
  kernel did not accept: when moving the child into the group fails, the group
  is released and `resourceLimits` is left unset rather than advertised.
- `scripts/check-security.mjs` grew from 42 to 46 checks: cgroup teardown is
  idempotent and removes the group, a real sandbox run resolves and leaves no
  group behind, the production CSP has no `'unsafe-eval'` and blocks framing and
  plugins, and `next.config` wires the policy to every route with
  `poweredByHeader: false`.

## 2026-11-28 (supply chain, live-provider structured output, smoke truth)

- Dependency gate is blocking. `npm run check:audit` fails CI on any high or
  critical advisory in the production tree that is not in
  `scripts/npm-audit-allow.json` with a written reason (the list is empty), and
  the step in `.github/workflows/ci.yml` no longer has `continue-on-error`.
  Both high findings are fixed at source rather than allowlisted: `postcss`
  is pinned to `^8.5.23` and `image-size` to `^2.2.0` through npm `overrides`.
  `scripts/check-security.mjs` pins the gate's failure path (a synthetic
  critical advisory must exit 1) and that CI runs it blocking.
- OpenRouter structured output works. The provider was running in
  `json_object` mode, so `Output.object` failed two ways: upstream rejects the
  request unless the prompt contains the word "json", and unconstrained JSON
  fails schema parsing. `createOpenAICompatible` now sets
  `supportsStructuredOutputs` (turn off with `OPENROUTER_STRUCTURED_OUTPUTS=0`
  for a model that rejects `json_schema`). Verified live: `/api/structured`,
  `/api/agent` structured, and the workflow planner all pass over OpenRouter.
- `tests/smoke.mjs` caught up with the tenant-scoped governance APIs
  (`planTransaction`/`simulate`/`approve`/`execute` take a `{tenant, actor}`
  scope; `getRun` needs an org) and now also asserts that a run is invisible
  from another org and unreadable without one. Suite: 60/60 in the default
  configuration, 59/60 over OpenRouter with a non-default
  `AI_DEFAULT_MODEL` (the remaining check pins the stock default model id).

## 2026-11-28 (tenant isolation, dual approval, sandbox gate)

Closes the four P0 findings from the assurance review and the supporting
hardening around them. Every fix carries a regression test in
`scripts/check-security.mjs` (28 → 36 checks).

- Memory is scoped to the authenticated `(tenant, owner)` pair
  (`src/lib/memory.ts`, migration 17). Recall and context no longer read other
  users' rows; agent-scope facts are per owner. Conversation ids are claimed by
  the identity that first uses them, and a request presenting someone else's id
  gets a fresh thread instead of that conversation — ids are not capabilities.
  `src/app/api/chat/route.ts` and `src/app/api/agent/route.ts` resolve the
  conversation server-side; the legacy "default" thread is per identity.
- Transactions (`src/lib/transaction.ts`) filter by tenant on every read and
  transition, so a foreign id is indistinguishable from a missing one. Approval
  is bound to a SHA-256 of the exact plan; the maker cannot approve; destructive
  kinds need two distinct approvers, neither the maker; execution takes an
  atomic lease so two workers cannot run one plan (a mid-run plan edit aborts).
  The route writes a fail-closed audit record before approve/execute/compensate.
- Governance (`src/app/api/governance/route.ts`) scopes audit, capabilities,
  durable runs and verification reports to the tenant inside the query; audit,
  run histories and reports are admin-only, a non-admin sees only their own
  grants, and a capability can only be granted to a principal in the caller's
  tenant. `listAudit`, `listRuns`, `getRun`, `listReports` and
  `listCapabilities` return nothing without a tenant.
- Sandbox (`src/lib/sandbox-isolation.ts`, `src/lib/sandbox.ts`): production
  requires a filesystem-isolating jail. `netns` (network namespace, host
  filesystem visible) and `none` are refused; `QUILLON_SANDBOX_ALLOW_UNJAILED`
  no longer overrides production.
- MCP (`src/lib/mcp.ts`): a stored env value in the sealed format that will not
  decrypt now fails that server closed instead of being passed to the process.
- `docker-compose.yml`: Redis is no longer published to the host, requires a
  password, and the app runs read-only with all capabilities dropped and
  `no-new-privileges`.
- `.github/workflows/ci.yml`: actions pinned to full commit SHAs, least-privilege
  `permissions`, no persisted credentials, plus `npm audit --audit-level=high`.

## 2026-11-28 (accessibility pass on the landing page)

Browser checks at 390px and 1280px now report zero low-contrast text, zero
clipped text and zero overlapping elements.

- `src/app/globals.css` — `--faint` goes from `#6b7380` to `#606875`, which
  reaches 4.8:1 on the `--bg-deep` stat band and 5.2:1 on `--bg`. The stat band
  labels ("provider integrations", "industry packages" and the rest), the brand
  subtitle, terminal dim lines and the composer placeholder now pass WCAG AA
  instead of sitting at 4.1–4.5:1.
- `src/app/ledger.css` — the hero title takes 16px of space above it so the
  uppercase eyebrow no longer overlaps it at phone width.
- `src/app/page.tsx` — the stream-inspector line that truncates a long tool
  payload now carries the full text in `title`, so the ellipsis is not lost
  information.

## 2026-11-28 (tool authority, checkpoints)

Follow-up to the security review: the remaining authorisation, timeout, egress
and audit-integrity findings are fixed, and `npm run check:security` grew from
19 to 28 checks.

- `src/lib/tool-manifest.ts` (new) — an explicit class for all 364 tools
  (built-in, OpenRouter, Salesforce, HubSpot, NetSuite, Costpoint, the 41
  enterprise platforms). `classifyTool` reads the table and never infers a class
  from a name; a tool missing from it is denied to every role. Administrative
  OpenRouter operations (`or_external_users_create`, `or_private_endpoints_create`,
  `or_private_providers_create`, `or_request`), `runCode` and credential or
  tenancy surfaces are `admin`. Regenerate with
  `node --loader ./scripts/ts-resolve.mjs scripts/generate-tool-manifest.mjs`;
  the check suite fails when a declared tool has no class.
- `src/lib/tool-authority.ts` — manifest lookup, MCP tools administrator-only
  unless the server is named in `QUILLON_MCP_MEMBER_SERVERS`, hard deny list
  (`QUILLON_TOOL_DENY`), member allow list (`QUILLON_TOOL_ADMIN_ALLOW`).
- `src/lib/tool-policy.ts` — capability grants are now mandatory for member and
  viewer sessions (admins hold the platform; `QUILLON_REQUIRE_GRANTS=1` forces
  them for everyone), bound to `capabilitySubject(session)` — tenant and signed-in
  user — instead of a caller-supplied conversation id. Timeouts abort the call's
  signal and tell the model a timed-out write may already have landed.
- `src/lib/tool-signal.ts` (new) + `src/lib/connector-sdk.ts` — the tool call's
  AbortSignal reaches connector fetches, so a timeout or cancelled turn cancels
  the outbound request instead of leaving it running.
- `src/lib/record-policy.ts` (new) — payroll, employee, vendor, journal and
  access-control records (and sensitive fields such as salary, SSN or bank
  details) are administrator-only for writes in Salesforce, HubSpot, NetSuite and
  Costpoint; `QUILLON_RECORD_ALLOW` re-opens named ones.
- `src/lib/net-guard.ts` — the allowlist now selects hosts instead of skipping
  address validation: an allowlisted name resolving to loopback, a private range
  or a metadata endpoint is refused unless the host is also in
  `QUILLON_EGRESS_PRIVATE_HOSTS`. Socket-level DNS pinning still needs
  network-layer egress control.
- `src/lib/audit-checkpoint.ts` (new) + migration 16 — HMAC-signed checkpoints of
  the audit head, chained, re-verifiable, exportable to an https endpoint or an
  append-only file (`QUILLON_AUDIT_KEY`, `QUILLON_AUDIT_SINK`). Governance API:
  `{"op":"audit-checkpoint"}`, `{"op":"audit-verify"}`.
- `src/lib/sandbox-isolation.ts` — code execution requires OS isolation in
  production; `QUILLON_SANDBOX_ALLOW_UNJAILED=1` is the explicit opt-out.

## 2026-11-28

Security hardening across every trust boundary, with a new regression suite
(`npm run check:security`, 19 checks, wired into CI).

- `src/lib/sanitize.ts` — secret redaction with a `{ keepBase64 }` mode (generated
  file data URLs survive), bare `token=` patterns, `safeErrorMessage` that cuts
  **any** `scheme://` URL including `postgres://user:pw@host/db`, HTML/SVG
  sanitisers, CSV formula neutralisation and `isActiveMediaType`.
- `src/lib/tool-policy.ts` — the single tool wrapper now deep-redacts every tool
  result before it reaches the model and replaces tool errors with short
  sanitised messages, so chat, agent, connector, ERP and MCP tools are all
  covered in one place.
- `src/app/api/files/route.ts` — HTML/SVG/XML attachments are served as
  `attachment` inside `Content-Security-Policy: sandbox` with `nosniff` and
  sanitised filenames instead of rendering on the app origin.
- `src/lib/connector-sdk.ts`, `salesforce.ts`, `hubspot.ts`, `netsuite.ts`,
  `costpoint.ts`, `openrouter.ts` — platform error bodies go through
  `safeErrorMessage` (no URLs, tokens or stack detail reach the model).
- `src/lib/costpoint.ts` — `If-Match: *` is gone: delete and batch patch re-read
  the live ETag and refuse when the server issues none (`deleteRecordGuarded`,
  `patchRecordGuarded`).
- `src/lib/netsuite.ts` — SuiteQL is read-only: non-SELECT, DDL and
  multi-statement queries are refused in the client before any request
  (`checkReadOnlySuiteQL`).
- `src/lib/net-guard.ts` — fixed a real SSRF hole: IPv4-mapped IPv6
  (`::ffff:127.0.0.1`) and IPv4-compatible addresses were not blocked.
- `src/lib/rbac.ts` — an unrecognised role claim now resolves to viewer (fail
  closed) instead of member.

## 2026-11-27

- Removed the fabricated demo tools (`weather`, `convertTemperature`,
  `getTime`) and their UI cards, starters and `QUILLON_DEMO_TOOLS` switch: the
  platform tools are `runCode`, `makeDocument` and `searchConnector`, plus the
  connector, deep-integration, memory and MCP surfaces. Smoke tests now drive
  the real `runCode` tool.
- `src/lib/mcp.ts` gained `closeMcpClients()`; the orchestration check calls it
  so a pooled stdio MCP server no longer keeps the process (and CI job) alive.

- Deep OpenRouter integration (`src/lib/openrouter.ts`, contract
  `openrouter.openapi.yaml` trimmed from the official spec, 93 operations): 92
  `or_*` tools — chat completions with model fallbacks and provider routing,
  Responses API, Messages API, preset runs, embeddings and rerank routers,
  audio transcription, text-to-speech, image generation, video generation
  with polling and content download, alpha decisions/extractions, the full
  model catalog (detail, provider endpoints, speech/embedding/image/video
  model lists, providers, tools, benchmarks),
  credits/purchases/generation/activity/analytics/feedback, provisioning-key
  CRUD, BYOK keys, workspaces (members, budgets), organization members and
  settings, external users, guardrails CRUD, observability destinations,
  private endpoints/providers, files (multipart upload, content, delete),
  batch jobs and container files. Bearer auth + HTTP-Referer/X-Title attribution,
  one Retry-After-aware retry on 429/502/503, never retried on ambiguous
  inference failures. Wired into the unified tool registry
  (`or_*` tools register only when `OPENROUTER_API_KEY` is set); attribution
  headers also sent by the chat model routing. Checks: `npm run
  check:openrouter` (mock-server suite, 147 assertions + 93-op contract pin), in CI.

- Deep Deltek Costpoint integration (`src/lib/costpoint.ts`, contract
  `costpoint.openapi.yaml`): 10 `cp_*` tools — OData v4 queries with automatic
  `$skip` paging (10k row cap), record CRUD on any entity with `If-Match` ETag
  optimistic concurrency, batch upserts (<=100, per-record results), the
  `$metadata` catalog, labor actual posting (employee/project/WBS/date/hours),
  and one-call project and AP-voucher snapshots that chain header, detail and
  organization/vendor reads. Auth: OAuth2 password grant
  (`baseUrl|clientId|clientSecret|username|password`) or static API key
  (`baseUrl|apiKey` as `X-Api-Key`); access tokens cached with refresh on 401,
  one retry on 429/502/503 honoring `Retry-After`, OData error bodies
  (`{error:{code,message}}`) surfaced to the model. Wired into the unified tool
  registry; check with `npm run check:costpoint` (mock Costpoint server); added
  to CI.
- Deep NetSuite integration (`src/lib/netsuite.ts`, contract `netsuite.openapi.yaml`): 11 `ns_*` tools —
  SuiteQL with automatic offset paging (10k row cap), record CRUD for any REST record type, external-ID
  upsert (PUT, Id from the 204 Location header), `eid:` external-ID addressing, sublist reads, record
  transforms (`salesOrder -> invoice`), batch upsert (<=50) and the record metadata catalog. OAuth 1.0
  Token-Based Authentication with HMAC-SHA256 (sandbox realm `123456-sb1` -> `123456_SB1`), one retry on
  429/502/503, and NetSuite `o:errorCode` error bodies surfaced to the model. Wired into the unified tool
  registry; check with `npm run check:netsuite` (mock SuiteTalk server cryptographically verifies every
  OAuth signature); added to CI.

## 2026-11-26

- Connectors: every platform recipe wired to its official API docs — credential-derived base URLs
  (Zendesk, Freshdesk, ServiceNow, Shopify, Mailchimp, Datadog, Xero, Salesforce), official Basic-auth
  formats, required version/tenant headers (GitHub 2022-11-28, Notion 2026-03-11, Intercom 2.18,
  Xero `xero-tenant-id`, Shopify Admin 2026-10), Stripe form-encoded bodies, Slack `ok:false` handling,
  429 `Retry-After` surfaced, and documented error bodies parsed into tool messages.
- Fixed: Salesforce actions previously targeted `login.salesforce.com` and could never succeed; they
  now call the org's instance URL.
- Connector SDK: auth receives `{token, account}`; Account field documents subdomain / tenant /
  app-key / shop / datacenter per platform (see README table).
