# MCP Gateway

Turn your REST API (OpenAPI spec) into a hosted, production-ready MCP server that AI agents can connect to — in 10 minutes.

> **Status:** Phase 2 — import an OpenAPI spec, curate tools, and serve them as a hosted MCP endpoint behind API keys. Rate limiting, request logging and analytics are next.

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

## Try it: from an OpenAPI spec to MCP Inspector

1. Start everything (`docker compose up -d`, then `pnpm dev`) and sign up at http://localhost:3000.
2. **New project**, then on the **Spec** tab import a spec by URL, for example `https://petstore3.swagger.io/api/v3/openapi.json`. The upstream base URL is filled in from the spec.
3. On **Tools**, switch off the operations you do not want agents to see. Rename them or hide parameters if you like.
4. If your API needs authentication, set it under **Settings → Upstream authentication**. The secret is stored encrypted and never shown again.
5. On **API Keys**, create a key and copy it. It is shown once.
6. The **Overview** tab shows the full MCP URL (`http://localhost:4000/mcp/<slug>`). Connect with the Inspector:

   ```bash
   npx @modelcontextprotocol/inspector
   ```

   In the Inspector: **Add Servers → + Add manually**, set **Transport** to `streamable-http`, paste the URL and click **Add**. Open that server's **Settings → Custom Headers → + Add Header** and enter `Authorization` / `Bearer <your key>`. Switch the server on (it shows *Connected*), open **Tools**, pick one and click **Execute Tool**. The Inspector keeps headers in plain text in `~/.mcp-inspector/mcp.json`, so use a key you can revoke. On Node below 22.19, `npx` installs Inspector v1, whose screens differ: set **Transport Type** to *Streamable HTTP*, paste the URL, open **Authentication → Custom Headers**, add `Authorization` / `Bearer <your key>`, switch the header on and click **Connect**. Or without a browser:

   ```bash
   npx @modelcontextprotocol/inspector --cli http://localhost:4000/mcp/<slug> --transport http \
     --header "Authorization: Bearer <your key>" --method tools/list
   ```

## Run the gateway in Docker

The gateway ships as a standalone image, configured only through environment variables, so it can run on Render, Koyeb or any VM:

```bash
docker build -f apps/gateway/Dockerfile -t mcp-gateway .

docker run --rm -p 4000:4000 \
  -e DATABASE_URL="postgresql://user:pass@host:5432/mcpgateway" \
  -e REDIS_URL="redis://host:6379" \
  -e ENCRYPTION_KEY="<the same 64 hex characters the dashboard uses>" \
  mcp-gateway
```

Hosting platforms that assign a port set `PORT`, which the gateway honours. The image does not run migrations (use `pnpm db:migrate:deploy` against the production database), and `ENCRYPTION_KEY` must match the dashboard's, or stored credentials cannot be decrypted. Set `GATEWAY_PUBLIC_URL` on the dashboard to the gateway's public address so the connection instructions show the right URL.

## Project structure

```
apps/
  web/        Next.js dashboard (UI + dashboard API)
  gateway/    Fastify MCP gateway (public, multi-tenant)
  worker/     BullMQ log consumer + analytics rollups
packages/
  db/              Prisma schema, client, migrations, seed
  shared/          Zod schemas, shared types
  openapi-tools/   OpenAPI → tool definitions, argument mapping, request building
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
