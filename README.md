## Buildora Monorepo Scaffold

This repository provides a TypeScript-first monorepo with PNPM workspaces for the Buildora apps and shared packages.

### Prerequisites
- Node.js 20+
- [pnpm](https://pnpm.io/installation)
- Docker (optional, for local infrastructure)

### Environment
1. Copy `.env.example` to `.env.local` and fill in secrets.
2. Environment variables are validated via `packages/shared/src/env.ts` using a Zod schema. Missing or invalid values will throw at startup.

### Install & Scripts
```bash
pnpm install
pnpm dev:all     # run all app dev servers in parallel
pnpm build:all   # build every workspace
pnpm lint        # eslint across workspaces
pnpm typecheck   # project-wide TypeScript checks
```

Each app (`apps/*`) exposes `dev`, `build`, `start`, `lint`, and `typecheck` scripts. The shared package publishes the environment helper.

### Workspace Layout
- `apps/assistant`
- `apps/mcp`
- `apps/channels/wa`
- `apps/console`
- `packages/shared`
- `infra/docker`

### WhatsApp Channel
- `apps/channels/wa` serves `/webhook` for Meta (WhatsApp) callbacks, requiring `WA_VERIFY_TOKEN` and `WA_APP_SECRET`.
- On inbound messages it upserts leads, contacts, conversations, stores WhatsApp metadata, and enqueues `dialogue` jobs in Redis.
- Template JSONs live under `apps/channels/wa/templates`; use `pnpm --filter @buildora/channel-wa templates list` or `... templates push <file>` to manage WhatsApp templates via Graph API.

### Assistant Worker
- `apps/assistant` runs a BullMQ worker that consumes `dialogue` jobs and orchestrates LLM-driven replies.
- Configure `MCP_SERVER_URL`, `OPENAI_API_KEY`, and `OPENAI_MODEL`; the worker will call MCP tools (lead lookup, consent, calendar, quotes) and post WhatsApp replies when policy allows.
- Proactive journeys use `WA_TEMPLATE_INTRO`, `WA_TEMPLATE_NUDGE1`, `WA_TEMPLATE_NUDGE2`, and `WA_TEMPLATE_LANGUAGE` to schedule templated nudges while respecting consent and quiet hours.

### Console UI
- `apps/console` is a lightweight React/Vite dashboard. Set `VITE_ASSISTANT_BASE_URL` to the assistant API origin (defaults to `http://localhost:4001`).
- `pnpm --filter @buildora/console dev` launches the UI on port 5173.
- The assistant exposes REST endpoints:
  - `GET /api/conversations` — latest threads with journey metadata
  - `GET /api/conversations/:id` — full transcript and journey state
  - `POST /api/conversations/:id/suppress` with `{ "suppress": true|false }` — toggles 48 h automation suppression

### Local Infrastructure
Spin up required services with:
```bash
docker compose -f infra/docker/docker-compose.yml up -d
```

This starts PostgreSQL, Redis, and LocalStack (S3).
