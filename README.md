# Quillon

**The open-source enterprise AI platform.** Streaming chat, a brand hub and
document studio, unattended work for every industry, 41 enterprise connectors,
SSO, and native local-LLM support — one self-hosted deploy, Apache-2.0.

Quillon is a workbench around the [AI SDK](https://ai-sdk.dev), not a
replacement for it: the same hooks, transport and tool definitions you would
write in a plain app, with an inspectable surface for every capability.

## Highlights

- **Chat & documents** — streaming chat with attachments, typed tool parts and
  real Office generation: Excel, Word and PowerPoint the model builds and the
  user downloads.
- **Brand hub** — one kit per brand: palette, fonts, written guidelines, voice
  and logo assets. Everything generated references it.
- **Template cloning** — upload an existing `.pptx`, `.docx` or `.xlsx` and
  Quillon unzips the OOXML theme part for the exact palette, fonts and slide
  size, saving it as a reusable template.
- **Document studio** — standard templates (pitch deck, status deck, business
  memo, sales one-pager, budget vs actual, RFP response outline) generated
  on-brand from the kit.
- **Unattended work** — scheduled jobs (hourly/daily/weekly) with a full run
  history, dispatchable to registered cloud computers over SSH.
- **Industry packages** — GovWin & capture (SAM.gov scoring, recompete
  watchlists), auto-RFP (shredding, compliance matrix, drafted responses),
  FP&A (variance narratives, rolling forecasts), investment research (sourced
  memos, comps, market maps), legal, field operations.
- **Evaluation Forensics** — an Evaluator Twin that simulates a source
  selection board pre-submission, Debrief Forensics that verifies each
  recorded evaluation finding against your own proposal text, a protest clock
  with rule sources, and a protest-decision corpus that grounds both. Every
  cited proposal quote is checked verbatim; fabricated quotes are discarded and
  logged, and documents need a Procurement Integrity Act attestation before
  they are stored.
- **Local LLMs** — native `ollama/*` and `local/*` model ids via the
  OpenAI-compatible protocol: Ollama, LM Studio, vLLM, llama.cpp.
- **Enterprise** — Entra ID / any-OIDC SSO, 41 connectors with AES-256-GCM
  token storage, agent memory, auto-compaction, skills and MCP.
- **Deep ERP/CRM integrations** — native `sf_*` (Salesforce), `hs_*` (HubSpot)
  and `ns_*` (NetSuite SuiteTalk REST) toolsets with their own OpenAPI
  contracts (`salesforce.openapi.yaml`, `hubspot.openapi.yaml`,
  `netsuite.openapi.yaml`); the NetSuite connector takes Token-Based
  Authentication credentials as
  `accountId|consumerKey|consumerSecret|tokenId|tokenSecret`.
- **Deep Deltek Costpoint integration** — native `cp_*` tools
  (`costpoint.openapi.yaml`): OData v4 queries with automatic `$skip` paging
  (10k-row cap), record CRUD on any entity with `If-Match` ETags, batch upserts
  (<=100, per-record results), the `$metadata` catalog, labor actual posting,
  and one-call project / AP-voucher snapshots that chain header, detail and
  organization/vendor reads. Costpoint Cloud auth is OAuth2 (password grant
  with a registered API client) — store
  `baseUrl|clientId|clientSecret|username|password` on the costpoint connector;
  on-prem static API keys use `baseUrl|apiKey` (sent as `X-Api-Key`). Check
  with `npm run check:costpoint` (mock Costpoint server, no live environment).

### Governance and reliability

- **Authenticated API surface** — every sensitive route is gated by session
  auth with RBAC (admin/member/viewer), Origin-based CSRF checks and an
  append-only audit trail. Turn enforcement on with SSO config or
  `QUILLON_REQUIRE_AUTH=1`; admins via `QUILLON_ADMIN_EMAILS`.
- **Fail-closed secrets** — production refuses the dev fallback for signing and
  connector-encryption keys unless `QUILLON_ALLOW_DEV_SECRET=1` is set
  explicitly. `AUTH_SECRET_PREVIOUS` keeps rotated-key data readable.
- **MCP restrictions** — remote servers must be http(s), never a cloud-metadata
  endpoint, and hosts must be on `QUILLON_MCP_ALLOWED_HOSTS` when set; stdio
  executables must be on `QUILLON_MCP_STDIO_COMMANDS`; server env vars are
  encrypted at rest; registration is admin-only.
- **Durable execution** — runs with per-step checkpoints survive restarts:
  workers lease runs, expired leases are requeued, failures retry up to
  `max_attempts` and dead-letter for one-click replay (Govern panel or
  `POST /api/worker {"op":"replay"}`).
- **Transactional AI** — consequential actions follow
  plan → simulate → approve → execute → verify → compensate
  (`src/lib/transaction.ts`, `/api/transactions`): nothing executes without
  approval, executed steps record undo payloads, failures compensate in
  reverse order, and every event lands in the agent replay log.
- **Capability security** — agents act on short-lived, narrowly scoped grants
  (`src/lib/capability.ts`), checked server-side before any connector
  credential is touched — never by the model.
- **Knowledge graph** — a permission-scoped business graph with provenance
  (`src/lib/graph.ts`, `/api/graph`): entities, typed relations, source system
  and reference per edge, multi-hop expansion for questions that span systems.
- **Work verification engine** — spreadsheets (broken refs, hardcoded literals
  in formula columns, formula-pattern deviations), decks (font drift,
  overflow, missing titles) and documents (citations, structure, date
  consistency) get auditable pass/warn/fail reports (`/api/verify`).
- **Data-boundary guards** (`src/lib/sanitize.ts`, regression suite
  `npm run check:security`): every tool result is secret-redacted before it
  reaches the model, tool errors become short sanitised sentences with no
  internal URLs or connection strings, HTML/SVG/XML attachments are served as
  sandboxed downloads instead of rendering on the app origin, and CSV exports
  are formula-neutralised.
- **Guarded writes** — ERP updates and deletes re-read the record's live ETag
  before writing and refuse when the server issues none (`If-Match: *` is never
  sent); NetSuite SuiteQL runs read statements only, enforced in the client
  before the request.
- **SSRF defence** — `src/lib/net-guard.ts` blocks loopback, private,
  link-local, CGNAT, metadata and NAT64/6to4 destinations, including
  IPv4-mapped IPv6 (`::ffff:127.0.0.1`), and revalidates every redirect hop.
  The egress allowlist chooses which hosts may be reached; it does not switch
  off address checks — an allowlisted name that resolves privately is refused
  unless the operator names it in `QUILLON_EGRESS_PRIVATE_HOSTS`.
- **Tool authority** — `src/lib/tool-manifest.ts` gives every one of the 364
  tools an explicit class (read / write / destructive / admin) and
  `src/lib/tool-authority.ts` filters the toolset by role before it reaches the
  model. Nothing is classified by name: a tool that is not in the manifest is
  denied to every role, `runCode` and OpenRouter's administrative endpoints are
  administrator-only, and third-party MCP tools need the server named in
  `QUILLON_MCP_MEMBER_SERVERS` before a member may call them.
- **Capability and record policy** — connector actions need an expiring grant
  bound to the signed-in user and tenant (`capabilitySubject`), mandatory for
  member and viewer sessions; payroll, employee, vendor and journal records
  (plus salary, SSN and bank fields) are administrator-only for writes across
  Salesforce, HubSpot, NetSuite and Costpoint (`src/lib/record-policy.ts`).
  Timeouts abort the call's AbortSignal, so a timed-out write is cancelled
  rather than left running behind the model.
- **Audit integrity outside the database** — `src/lib/audit-checkpoint.ts`
  signs the audit head with `QUILLON_AUDIT_KEY`, chains the checkpoints and can
  ship each one to an https endpoint or an append-only file
  (`QUILLON_AUDIT_SINK`). `POST /api/governance {"op":"audit-verify"}` re-checks
  signatures and proves the signed rows still exist.

## Quick start

```bash
npm install
npm run dev        # http://localhost:3000
```

Set one key and every surface streams real tokens.

### One key

```bash
AI_GATEWAY_API_KEY=...     # or OPENAI_API_KEY / ANTHROPIC_API_KEY / OPENROUTER_API_KEY
```

### Fully local, zero cloud keys

```bash
ollama serve && ollama pull llama3.1
OLLAMA_BASE_URL=http://127.0.0.1:11434 npm run dev
```

Pick **Ollama · llama3.1 (local)** in the model picker. Any OpenAI-compatible
server works: set `LOCAL_LLM_BASE_URL=http://127.0.0.1:1234` for LM Studio,
vLLM or llama.cpp.

### Docker

```bash
docker compose up   # app + postgres + redis, then open http://localhost:3000
```

## Setup in four steps

1. **Set one model key** — or run Ollama locally with zero keys.
2. **Create a brand kit** — colors, fonts, guidelines, voice become the source
   of truth for every document.
3. **Clone a template** — upload a `.pptx` or `.docx`; its theme is captured
   exactly.
4. **Turn on unattended work** — enable a seeded job from an industry package.

The **Setup** panel in the workspace (`/workspace?panel=setup`) shows each
check, what is missing and the exact env var or command to fix it.

## Model providers

Native AI SDK provider packages, keyed by env var: OpenAI, Anthropic, Google,
xAI, Mistral, Groq, DeepSeek, Perplexity, Amazon Bedrock, Azure, OpenRouter,
plus `ollama/*` and `local/*` for self-hosted models.

### OpenRouter deep integration

`src/lib/openrouter.ts` wires the full official OpenRouter API surface
(`openrouter.openapi.yaml`, trimmed from the published spec) as 37 `or_*`
tools in the unified registry whenever `OPENROUTER_API_KEY` is set:

- **Inference** — chat completions with model fallbacks, provider routing
  (`provider.order`, `allow_fallbacks`), JSON mode and usage accounting; the
  OpenAI-style Responses API; the Anthropic-style Messages API; running a
  saved preset (`/presets/{slug}/chat/completions`); the embeddings router;
  the rerank router; audio transcription (multipart); text-to-speech
  (returned as a playable data URL); image generation; video generation with
  job polling and content download; alpha decisions/extractions.
- **Catalog** — model search with free/modality filters, per-model detail
  (`/model/{author}/{slug}`), upstream provider endpoints
  (per-provider pricing and uptime), speech/embedding/image/video model
  lists, `/models/count`, `/models/user`, providers, tool definitions,
  benchmarks and task classifications.
- **Accounting** — credit balance, purchase history, per-generation cost
  lookup (`/generation?id=` — note: OpenRouter indexes generations
  asynchronously, so a fresh id can 404 briefly), usage activity, the
  analytics meta/query API, per-generation feedback and the generated-content
  list.
- **Key management** — provisioning key list/create/update/delete with spend
  limits and expiry (management key), and BYOK provider keys
  (list/add/delete) to route through your own upstream accounts.
- **Enterprise management** (management key) — workspaces (CRUD, bulk member
  add, budgets by interval), organization members and settings, external
  users, guardrails (CRUD), observability/OTel destinations, private
  endpoints (create plus activate/disable/enable/validate) and private
  providers.
- **Bulk** — file upload (multipart), metadata, content download and delete;
  batch jobs create/status/cancel; code-container file list/read/download/
  promote.
- **Escape hatch** — with `OR_ALLOW_RAW=1`, an `or_request` tool exposes any
  authenticated path; off by default.

Transport details: `HTTP-Referer` + `X-Title` attribution headers on every
call, bearer auth from `OPENROUTER_API_KEY`, one retry on 429/502/503
honoring `Retry-After` (never on ambiguous inference failures), 300s
inference / 60s metadata timeouts, and `{error:{code,message}}` bodies
surfaced to the model. Optional overrides: `OPENROUTER_BASE_URL`,
`OPENROUTER_APP_NAME`, `APP_URL`.

Verify: `npm run check:openrouter` (mock-server behaviour suite, 147
assertions, + contract pin of all 93 operations against the official spec).

## Architecture

- `src/app` — Next.js App Router: the consolidated Ask page, the workspace
  shell and one route handler per capability (`api/chat`, `api/agent`,
  `api/studio`, `api/brand`, `api/jobs`, `api/packages`, `api/computers`,
  `api/setup`, …).
- `src/lib` — sandbox (subprocess isolation, timeouts, file capture), office
  generation (ExcelJS / docx / pptxgenjs), OOXML theme cloning (JSZip), jobs
  and scheduling, cloud computers, connector SDK, models registry, SQLite
  persistence (`node:sqlite`, file at `.data/quillon.db`).

## Development

```bash
npx tsc --noEmit           # type check
npm run build              # production build
npm run check:security     # trust-boundary suite (redaction, SSRF, tool authority, audit checkpoints)
npm run check:audit        # dependency gate: fails on an unallowlisted high/critical advisory
node tests/smoke.mjs       # route + UI smoke tests (no key needed)
```

## License

Apache-2.0. See [LICENSE](LICENSE) and [CHANGELOG.md](CHANGELOG.md).
