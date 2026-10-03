# MCP Gateway — Project Spec

> Put this file at `docs/SPEC.md` in an empty repo. Claude Code: read this whole file before doing anything, and treat it as the source of truth for scope, stack and rules.

## 1. What we are building

A SaaS platform that lets a small software team **turn its REST API (described by an OpenAPI spec) into a hosted, production-ready MCP server** that AI agents (Claude, Cursor, VS Code Copilot, etc.) can connect to.

**Positioning:** "Ship an MCP server for your SaaS in 10 minutes." We serve the *publisher* side: teams exposing their own API to their customers' AI agents. We are not an enterprise gateway for governing employees' MCP usage.

**Two differentiators:**
1. **Tool curation.** Big APIs have 100+ endpoints, and agents perform badly with that many tools. The tool builder lets users choose, rename, describe and simplify endpoints into a small set of high-quality tools.
2. **Usage visibility.** Publishers see which tools agents call, how often, how fast, and what fails.

**Goals:** a working MVP that real developers can try, and a portfolio-quality codebase (clean architecture, tests, docs) for the author's resume.

## 2. Hard constraints

- **₹0 budget.** Use only free, open-source tools and free tiers. Never add a paid service or a dependency that requires a paid account. If something would cost money, stop and say so.
- **The gateway never calls an LLM.** The AI agents belong to our users' customers. No AI APIs are needed in the MVP.
- **No custom domain.** Everything must work on localhost, `*.vercel.app`, a Cloudflare Tunnel URL, or a raw VM IP.
- **TypeScript everywhere**, `strict` mode on.

## 3. Tech stack

| Area | Choice |
|---|---|
| Monorepo | pnpm workspaces + Turborepo |
| Dashboard | Next.js (App Router) + Tailwind CSS + shadcn/ui, in `apps/web` |
| Dashboard backend | Next.js route handlers / server actions inside `apps/web` |
| Dashboard auth | Auth.js (NextAuth) with GitHub OAuth + email/password |
| Gateway | Node + Fastify + official MCP TypeScript SDK (`@modelcontextprotocol/sdk`), Streamable HTTP transport, in `apps/gateway` |
| Background worker | BullMQ consumer for logs, in `apps/worker` |
| Database | PostgreSQL + Prisma, schema in `packages/db` |
| Cache / queues / rate limits | Redis |
| OpenAPI parsing | `@apidevtools/swagger-parser` (or equivalent), in `packages/openapi-tools` |
| Shared types and validation | Zod, in `packages/shared` |
| Tests | Vitest (unit/integration), Playwright (a few end-to-end flows) |
| Local infra | Docker Compose (Postgres + Redis) |
| CI | GitHub Actions: lint, typecheck, test on every PR |

**Important:** the MCP spec and SDK change quickly. Before writing any MCP code, read the current SDK README and examples (in `node_modules/@modelcontextprotocol/sdk` and the official docs) and follow the current APIs. Do not rely on memory for SDK class names or transport details.

## 4. Repo layout

```
apps/
  web/        Next.js dashboard (UI + dashboard API)
  gateway/    Fastify MCP gateway (public, multi-tenant)
  worker/     BullMQ log consumer + analytics rollups
packages/
  db/              Prisma schema, client, migrations, seed
  shared/          Zod schemas, shared types, constants
  openapi-tools/   OpenAPI -> MCP tool definitions (pure, heavily tested)
  crypto/          Encryption + API key hashing helpers
docs/
  SPEC.md          This file
  ARCHITECTURE.md  Written in Phase 0, kept updated
  DECISIONS.md     Short log of technical decisions and why
docker-compose.yml
```

## 5. Core concepts and data model

- **User:** signs into the dashboard.
- **Project:** one upstream API. Fields: name, unique slug, upstream base URL, raw OpenAPI spec (JSON), spec version/hash.
- **UpstreamCredential:** how the gateway authenticates to the upstream API. Types: none, bearer token, custom header, query param. The secret value is **encrypted at rest** (AES-256-GCM, key from env).
- **Tool:** an MCP tool derived from one OpenAPI operation. Fields: operationId, HTTP method, path, tool name, description, JSON Schema for input, enabled flag, hidden params with fixed default values.
- **ApiKey:** a key the publisher gives to their customers so agents can call the MCP endpoint. Store only a **SHA-256 hash** plus a short visible prefix (e.g. `mcpg_ab12…`). Fields: name, prefix, hash, rate limit per minute, lastUsedAt, revokedAt.
- **ToolCallLog:** one row per tool call: project, tool, api key, input (sensitive fields masked), output (truncated), upstream HTTP status, latency ms, success/error, error message, timestamp. Index on (projectId, createdAt).
- **UsageRollup:** hourly aggregates per project + tool (calls, errors, p50/p95 latency) produced by the worker for fast charts.

## 6. MVP features (in scope)

1. **Auth and projects:** sign up / log in; create, edit, delete projects.
2. **Spec import:** upload a JSON/YAML OpenAPI 3.x file or paste a URL. Validate and dereference it. Show clear errors for invalid specs.
3. **Tool builder:** list every operation as a candidate tool. Users can enable/disable, rename, edit descriptions, hide parameters (with a fixed value), and preview the generated JSON Schema. Sensible defaults: names from operationId (snake_case), descriptions from summary/description.
4. **Upstream credentials:** configure how the gateway authenticates to the upstream API.
5. **Hosted MCP endpoint:** `POST /mcp/:projectSlug` (Streamable HTTP). It must work with MCP Inspector and real MCP clients. `tools/list` returns only enabled tools; `tools/call` maps arguments to path/query/header/body params, calls the upstream API, and returns the response as MCP content.
6. **API keys:** create, list, revoke. Clients authenticate with `Authorization: Bearer <key>`.
7. **Rate limiting:** per API key, sliding window in Redis. Return a proper MCP/HTTP error when exceeded.
8. **Request logging:** the gateway pushes a log event to a BullMQ queue (never blocks the request); the worker writes it to Postgres and updates rollups.
9. **Analytics dashboard:** calls over time, top tools, error rate, p95 latency, recent calls table with a detail view.
10. **Playground:** call any enabled tool from the dashboard with a form generated from its schema, and see the raw upstream request and response.
11. **Connect instructions:** a page showing copy-paste config snippets for MCP Inspector, Claude, Cursor and VS Code.

## 7. Out of scope for the MVP (v2 ideas — do not build yet)

OAuth for end users, billing (Razorpay test mode comes later), combining several APIs into one MCP server, spec versioning, tool-health test suites, auto-generated docs pages, team members and roles, any AI-assisted features.

## 8. Security requirements (non-negotiable)

- **SSRF protection:** the gateway calls user-supplied URLs. Resolve hostnames and block private, loopback, link-local and metadata IP ranges (allow localhost only when `NODE_ENV=development`). Enforce timeouts (default 15s) and a max response size (default 1 MB).
- Encrypt upstream secrets at rest; never log or return them to the browser after saving.
- Hash API keys; show the full key only once at creation.
- Mask sensitive fields in logs (authorization, password, token, secret, api_key, and anything marked `format: password`).
- Validate every input with Zod at every boundary.
- Every database query is scoped to the current user's projects (no cross-tenant access). Add tests for this.
- Secrets only via environment variables; ship a `.env.example`, never commit `.env`.

## 9. Build phases

Work **one phase at a time**. At the end of each phase: run lint, typecheck and tests; update README and docs; make small conventional commits; then **stop and summarize what was done, how to try it, and what is next**. Wait for the user before starting the next phase.

**Phase 0: Foundation**
Monorepo, TypeScript configs, ESLint/Prettier, Docker Compose (Postgres + Redis), Prisma schema with all models above and an initial migration, seed script, GitHub Actions CI, `.env.example`, README with setup steps, `docs/ARCHITECTURE.md` with a diagram (Mermaid).
*Done when:* `pnpm install && docker compose up -d && pnpm db:migrate && pnpm dev` starts all three apps with no errors and CI passes.

**Phase 1: Hand-written MCP server spike**
In `apps/gateway`, build a minimal MCP server with two hard-coded tools over Streamable HTTP, to learn the SDK. Document how to connect with MCP Inspector.
*Done when:* MCP Inspector can list and call both tools.

**Phase 2: OpenAPI → tools**
`packages/openapi-tools`: parse, validate and dereference specs; convert operations into tool definitions (name, description, input JSON Schema merging path/query/header/body params); map tool arguments back into an HTTP request. Unit-test it heavily with fixtures (Petstore, plus a spec with nested bodies, arrays, enums, required fields and refs).
*Done when:* tests pass for all fixtures, including edge cases.

**Phase 3: Dashboard — auth, projects, spec import, tool builder**
*Done when:* a user can sign in, create a project, import the Petstore spec, and enable/rename/describe tools.

**Phase 4: Dynamic multi-tenant gateway**
`/mcp/:projectSlug` loads the project's enabled tools (cached in Redis, invalidated on change), executes calls against the upstream API with stored credentials, and applies SSRF protection, timeouts and size limits.
*Done when:* MCP Inspector connected to `/mcp/petstore` lists the enabled tools and a call returns real upstream data.

**Phase 5: API keys and rate limiting**
*Done when:* calls without a valid key are rejected, revoked keys stop working immediately, and exceeding the limit returns a clear error. Covered by integration tests.

**Phase 6: Logging, analytics, playground**
*Done when:* every call appears in the dashboard within a few seconds, charts show real data, and the playground can call any tool.

**Phase 7: Polish and launch prep**
Connect-instructions page, empty states, loading and error states, responsive layout, a landing page, Playwright tests for the main flow (sign up → import spec → create key → call tool), deployment guide for a free setup (Vercel for `web`, an Oracle Cloud always-free VM or Cloudflare Tunnel for `gateway` + `worker` + Redis, Neon for Postgres).
*Done when:* someone new can follow the README and get the whole thing running.

## 10. Working rules for Claude Code

- Ask before adding a dependency that is not in the stack table, and explain why it is needed.
- Prefer simple, readable code over clever abstractions. This codebase will be read by interviewers.
- Write tests alongside features, not at the end. Pure logic (`openapi-tools`, `crypto`, rate limiter) needs thorough unit tests.
- Keep `docs/DECISIONS.md` updated with one short entry per significant technical choice.
- If a requirement here is unclear or conflicts with how the current MCP SDK works, stop and ask instead of guessing.
- Never weaken a security requirement to make something work.
