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

### Local Infrastructure
Spin up required services with:
```bash
docker compose -f infra/docker/docker-compose.yml up -d
```

This starts PostgreSQL, Redis, and LocalStack (S3).
