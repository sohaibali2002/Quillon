# Changelog

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
