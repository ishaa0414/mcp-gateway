# MCP Gateway

Turn your REST API (OpenAPI spec) into a hosted, production-ready MCP server that AI agents can connect to — in 10 minutes.

> **Status:** Phase 0 — Foundation (monorepo setup, infra, DB schema, CI)

## Prerequisites

| Tool | Version |
|---|---|
| Node.js | ≥ 20.19 |
| pnpm | ≥ 12 |
| Docker Desktop | ≥ 4 (Engine running) |
| Git | ≥ 2.38 |

## Setup

```bash
# 1. Clone
git clone https://github.com/ishaa0414/mcp-gateway
cd mcp-gateway

# 2. Copy environment file and fill in secrets
cp .env.example .env

# Generate ENCRYPTION_KEY (paste into .env)
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"

# 3. Install dependencies
pnpm install

# 4. Start Postgres + Redis
docker compose up -d

# 5. Run database migrations
pnpm db:migrate

# 6. Seed the database (demo user + petstore project)
pnpm db:seed

# 7. Start all apps in development mode
pnpm dev
```

## Apps

| App | URL | Description |
|---|---|---|
| `apps/web` | http://localhost:3000 | Next.js dashboard |
| `apps/gateway` | http://localhost:4000 | Fastify MCP gateway |
| `apps/worker` | — | BullMQ log consumer |

## Scripts

```bash
pnpm dev           # Start all apps
pnpm build         # Build all apps and packages
pnpm lint          # Lint all packages
pnpm typecheck     # Typecheck all packages
pnpm test          # Run all tests

pnpm db:generate   # Re-generate Prisma client
pnpm db:migrate    # Run pending migrations (dev)
pnpm db:seed       # Seed the database
```

## Verify health

```bash
curl http://localhost:4000/health
# → { "postgres": "ok", "redis": "ok" }
```

## Project structure

```
apps/
  web/        Next.js dashboard (UI + dashboard API)
  gateway/    Fastify MCP gateway (public, multi-tenant)
  worker/     BullMQ log consumer + analytics rollups
packages/
  db/              Prisma schema, client, migrations, seed
  shared/          Zod schemas, shared types
  openapi-tools/   OpenAPI → MCP tool definitions (Phase 2)
  crypto/          AES-256-GCM + API key hashing
docs/
  SPEC.md          Project specification
  ARCHITECTURE.md  System diagram and component descriptions
  DECISIONS.md     Technical decision log
docker-compose.yml
```

## Documentation

- [Project Specification](docs/SPEC.md)
- [Architecture](docs/ARCHITECTURE.md)
- [Technical Decisions](docs/DECISIONS.md)
