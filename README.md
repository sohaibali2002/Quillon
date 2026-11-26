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
- **Local LLMs** — native `ollama/*` and `local/*` model ids via the
  OpenAI-compatible protocol: Ollama, LM Studio, vLLM, llama.cpp.
- **Enterprise** — Entra ID / any-OIDC SSO, 41 connectors with AES-256-GCM
  token storage, agent memory, auto-compaction, skills and MCP.

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


## Quick start

```bash
npm install
npm run dev        # http://localhost:3000
```

It starts in **mock mode** — every surface is live before you add a key.

### One key (or none)

```bash
AI_GATEWAY_API_KEY=...     # or OPENAI_API_KEY / ANTHROPIC_API_KEY / OPENROUTER_API_KEY
```

### Fully local, zero keys

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
npx tsc --noEmit      # type check
npm run build         # production build
node tests/smoke.mjs  # route + UI smoke tests (no key needed)
```

## License

Apache-2.0. See [LICENSE](LICENSE) and [CHANGELOG.md](CHANGELOG.md).
