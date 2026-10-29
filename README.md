# MCP Gateway

Turn your REST API (OpenAPI spec) into a hosted, production-ready MCP server that AI agents can connect to — in 10 minutes.

> **Status:** Phases 0–4 and Phase 5a done; Phase 5b (deployment and demo) next — import an OpenAPI spec, curate tools, try them in a playground, and serve them as a hosted MCP endpoint behind API keys, with per-key rate limiting, call logging, an analytics dashboard and copy-paste connection guides.

## Prerequisites

| Tool | Version |
|---|---|
| Node.js | ≥ 22.19 (22.23.3 recommended; `.nvmrc`) |
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
| `apps/web` | http://localhost:3000 | Next.js dashboard (the dev server listens on 127.0.0.1 only) |
| `apps/gateway` | http://localhost:4000 | Fastify MCP gateway |
| `apps/worker` | — | BullMQ log consumer (writes call logs, deletes old ones) |

## Scripts

```bash
pnpm dev           # Start all apps
pnpm build         # Build all apps and packages
pnpm lint          # Lint all packages
pnpm typecheck     # Typecheck all packages
pnpm test          # Run all tests (each package gets its own Postgres test database; see CLAUDE.md)

pnpm db:generate   # Re-generate Prisma client
pnpm db:migrate    # Run pending migrations (dev)
pnpm db:seed       # Seed the database
```

## Verify health

```bash
curl http://localhost:4000/health
# → { "status": "ok" }               # liveness only: is the process up

curl http://localhost:4000/ready
# → { "postgres": "ok", "redis": "ok" }   # 503 if either is unreachable
```

## Try it: from an OpenAPI spec to MCP Inspector

1. Start everything (`docker compose up -d`, then `pnpm dev`) and sign up at http://localhost:3000. Open it as `localhost`, not `127.0.0.1`: sign-in is tied to the `AUTH_URL` address. The dev server and the gateway listen on this machine only; to reach the dashboard from a phone on your network, run `pnpm --filter @mcp-gateway/web exec next dev --hostname 0.0.0.0` and set `AUTH_URL` to that address.
2. **New project**, then on the **Spec** tab import a spec by URL, for example `https://petstore3.swagger.io/api/v3/openapi.json`. The upstream base URL is filled in from the spec.
3. On **Tools**, switch off the operations you do not want agents to see. Rename them or hide parameters if you like.
4. If your API needs authentication, set it under **Settings → Upstream authentication**. The secret is stored encrypted and never shown again.
5. On **API Keys**, create a key and copy it. It is shown once.
6. The **Overview** tab shows the full MCP URL (`http://localhost:4000/mcp/<slug>`). Connect with the Inspector:

   ```bash
   npx @modelcontextprotocol/inspector
   ```

   In the Inspector: **Add Servers → + Add manually**, set **Transport** to `streamable-http`, paste the URL and click **Add**. Open that server's **Settings → Custom Headers → + Add Header** and enter `Authorization` / `Bearer <your key>`. Switch the server on (it shows *Connected*), open **Tools**, pick one and click **Execute Tool**. The Inspector keeps headers in plain text in `~/.mcp-inspector/mcp.json`, so use a key you can revoke. Or without a browser:

   ```bash
   npx @modelcontextprotocol/inspector --cli http://localhost:4000/mcp/<slug> --transport http \
     --header "Authorization: Bearer <your key>" --method tools/list
   ```

## Analytics

The **Analytics** tab of a project shows, for the last 24 hours, 7 days or 30 days (in your time zone): calls over time, error rate, p50 and p95 latency, the busiest tools, and a table of recent calls. Open a row to see its masked arguments and error message.

Rate-limited calls and auth failures are sampled when they are logged, so they show as "at least N" and are left out of the headline numbers.

To fill a project with demo data (local development database only; the script refuses production and non-local hosts):

```bash
pnpm db:seed:analytics --project <slug>   # add --rows N for more; re-running replaces the previous seed rows
```

## Playground

The **Playground** tab runs one of a project's enabled tools against your real API and shows the request and the response. Pick a tool, fill in its parameters and click **Run**. Tools that change data (anything but GET) ask for a confirmation first. Credentials are shown as `••••`; parameters you hid from agents are never sent.

The dashboard does not use an API key for this. Its server signs the request (HMAC-SHA256, 60 s window, one-time nonce) with `PLAYGROUND_SECRET` and sends it to an internal gateway route, which is only registered when the secret is set. Playground calls are limited per project (30 a minute by default) and are not written to the call log, so they do not show in Analytics. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the path end to end.

Set the secret once in the root `.env`, with the same value for the dashboard and the gateway. This appends a random one without printing it, and does nothing if the file already has a `PLAYGROUND_SECRET=` line:

```bash
node -e "const f=require('fs');const t=f.existsSync('.env')?f.readFileSync('.env','utf8'):'';if(/^PLAYGROUND_SECRET=/m.test(t)){console.log('PLAYGROUND_SECRET is already set; left as it is')}else{f.appendFileSync('.env','\nPLAYGROUND_SECRET='+require('crypto').randomBytes(32).toString('hex')+'\n');console.log('PLAYGROUND_SECRET added')}"
```

Never paste the secret into a chat or a ticket. Without it the tab shows "Playground not configured".

## Connect

The **Connect** tab gives copy-paste setup for MCP Inspector, Claude Code, Cursor and VS Code. Each snippet reads your API key from a per-project environment variable (`<SLUG>_MCP_KEY`, for example `PETSTORE_DEMO_MCP_KEY`), so the key itself is never in the snippet. The tab also shows how to set that variable without echoing the key.

## Configuration

The variables below are the ones you will most likely touch. `.env.example` lists every variable with its default and a comment.

| Variable | Default | What it does |
|---|---|---|
| `PLAYGROUND_SECRET` | unset | Shared by the dashboard and the gateway (at least 32 bytes). Unset: no playground route, and the tab says it is not configured. |
| `PLAYGROUND_RATE_PER_MIN` | `30` | Playground calls per project per minute (1–1000). |
| `GATEWAY_INTERNAL_URL` | `GATEWAY_PUBLIC_URL` | Where the dashboard's server reaches the gateway for playground calls. |
| `TOOL_CALL_TIMEOUT_MS` | `15000` | How long the gateway waits for your API. The playground waits this plus 5 s. Keep it equal on both sides. |
| `DATABASE_CONNECT_TIMEOUT_MS` | `5000` (worker `10000`) | How long a query waits for a Postgres connection before failing (100–120000). A stopped database then fails in seconds instead of hanging. On a hosted database that sleeps when idle, keep it above 3000 so a cold start can connect. |
| `GATEWAY_PUBLIC_URL` | `http://localhost:4000` | The address agents use; shown in the MCP URL and the Connect snippets. |

### Opening the dashboard

`pnpm dev` binds the dashboard to `127.0.0.1` only, so open it as `http://localhost:3000` (`AUTH_URL` is set to that). To reach it from a phone on your network, use the `--hostname 0.0.0.0` override and `AUTH_URL` change described in step 1 of [Try it](#try-it-from-an-openapi-spec-to-mcp-inspector).

### How fresh is what the gateway serves?

The gateway caches in Redis so a call does not hit Postgres every time. The dashboard clears the right entries when you change something, so changes and revocations take effect immediately:

- Revoking an API key clears that key's cached lookup at once.
- Toggling or editing a tool (including hidden parameters), re-importing the spec, changing credentials, editing project settings and deleting a project all clear the project's cached config at once.

Only if Redis is unreachable at that moment is the clear skipped (the dashboard then stops trying for 30 s). Until the cache entries expire on their own, a revoked key can keep working for up to `API_KEY_CACHE_TTL_SECONDS` (default 30 s), and a config change can take up to `CONFIG_CACHE_TTL_SECONDS` (default 300 s, so about 5 minutes) to reach the gateway.

The Playground reads the same cached config as agents do.

### End-to-end tests

`pnpm e2e` builds the gateway and a production build of the dashboard (into `apps/web/.next-e2e`, so a running `pnpm dev` is not affected), starts them with a fake upstream on ports 3110, 4110 and 4210, and runs the Playwright flows in `apps/e2e`. It needs Postgres and Redis up (`docker compose up -d`), uses its own database `mcpgateway_test_e2e` and Redis database 3, and opens your installed Chrome. `pnpm e2e:run` skips the build. Do not run it while `pnpm test` is running: the browser, `next start` and the gateway need a core or two and about 2 GB.

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

**Call logging in a deployment without a worker.** By default the gateway sends call logs to BullMQ and `apps/worker` writes them to Postgres. A free Redis plan (Upstash) cannot afford BullMQ's polling, so for a deployment without the worker set `LOG_SINK=direct`: the gateway then writes batches to Postgres itself and deletes logs older than `LOG_RETENTION_DAYS` (default 30) on its own. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#call-logging) for the buffer settings (`LOG_BUFFER_MAX`, `LOG_BATCH_SIZE`, `LOG_FLUSH_INTERVAL_MS`, `LOG_SHUTDOWN_FLUSH_MS`) and what is lost on a hard kill.

Hosting platforms that assign a port set `PORT`, which the gateway honours. The gateway binds `127.0.0.1` in development and `0.0.0.0` when `NODE_ENV=production` (the image sets it); `HOST` overrides either. The image does not run migrations (use `pnpm db:migrate:deploy` against the production database), and `ENCRYPTION_KEY` must match the dashboard's, or stored credentials cannot be decrypted. Set `GATEWAY_PUBLIC_URL` on the dashboard to the gateway's public address so the connection instructions show the right URL.

## Project structure

```
apps/
  web/        Next.js dashboard (UI + dashboard API)
  gateway/    Fastify MCP gateway (public, multi-tenant)
  worker/     BullMQ log consumer + log retention
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
