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
| Gateway | Node + Fastify + official MCP TypeScript SDK v2 (`@modelcontextprotocol/server` + `@modelcontextprotocol/node`; the old `@modelcontextprotocol/sdk` is v1, now maintenance-only), Streamable HTTP transport, in `apps/gateway` |
| Background worker | BullMQ consumer for logs, in `apps/worker` |
| Database | PostgreSQL + Prisma, schema in `packages/db` |
| Cache / queues / rate limits | Redis |
| OpenAPI parsing | `@apidevtools/swagger-parser` (or equivalent), in `packages/openapi-tools` |
| Shared types and validation | Zod, in `packages/shared` |
| Tests | Vitest (unit/integration), Playwright (a few end-to-end flows) |
| Local infra | Docker Compose (Postgres + Redis) |
| CI | GitHub Actions: lint, typecheck, test on every PR |

**Important:** the MCP spec and SDK change quickly. Before writing any MCP code, read the current SDK README and examples (in `node_modules/@modelcontextprotocol/server` and the official docs; findings so far are in `apps/gateway/examples/README.md`) and follow the current APIs. Do not rely on memory for SDK class names or transport details.

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

1. **Auth and projects:** sign up / log in (GitHub OAuth + email/password); create, edit, delete projects.
2. **Spec import:** upload a JSON/YAML OpenAPI 3.0/3.1 file (max 5 MB) or import from a URL (SSRF-safe server-side fetch). Validate, dereference, show clear errors.
3. **Tool builder:** enable/disable operations, rename, edit descriptions, hide params with fixed values, preview JSON schema. Re-importing keeps edits where operationId still exists.
4. **Upstream credentials:** none / bearer / custom header / query param, encrypted at rest.
5. **Hosted MCP endpoint:** `/mcp/:projectSlug` (Streamable HTTP). Works with MCP Inspector. `tools/list` returns enabled tools; `tools/call` maps args to HTTP params and calls upstream.
6. **API keys:** create, list, revoke. Bearer auth. SHA-256 hash stored, shown once.
7. **Rate limiting:** per API key, sliding window in Redis.
8. **Request logging:** gateway pushes to BullMQ; worker writes to Postgres and updates rollups. Sensitive fields masked.
9. **Analytics dashboard:** call volume over time, top tools, error rate, p50/p95 latency, recent calls with detail view.
10. **Playground:** call any tool from the dashboard with a schema-driven form, see raw upstream request/response.
11. **Connection instructions:** copy-paste snippets for MCP Inspector, Claude, Cursor, VS Code.

## 7. Out of scope for the MVP (v2 ideas — do not build)

OAuth for end users, billing, combining multiple APIs into one MCP server, spec versioning history, tool-health test suites, auto-generated public docs, team members and roles, AI-assisted features, custom domains.

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

**Phase 0: Foundation** ✅ *Done*
Monorepo (pnpm + Turborepo), TypeScript strict, ESLint/Prettier, Docker Compose (Postgres 17 + Redis 7), Prisma 7 schema with all models and initial migration, seed, GitHub Actions CI, `packages/crypto` (AES-256-GCM + API key), Fastify gateway (`/health`), BullMQ worker skeleton, Next.js 16 + Tailwind v4 home page.

**Phase 1: Auth, Projects, OpenAPI Import, Tool Builder** ✅ *Done*
Auth.js v5 (GitHub OAuth + email/password with argon2), projects CRUD, OpenAPI 3.0/3.1 import (file upload + SSRF-safe URL fetch in `packages/shared`), endpoint→tool conversion in `packages/openapi-tools` (heavily unit-tested with fixtures), tool editing UI (enable/disable, rename, description, hidden params, JSON schema preview). shadcn/ui dashboard layout (sidebar + tabs).
*Done when:* user can sign in, create a project, import the Petstore spec, and curate tools. Every DB query is scoped to the signed-in user. Tests cover conversion logic and cross-user access control.

**Phase 2: Hosted MCP Server** ✅ *Implemented, in review*
`/mcp/:projectSlug` (Streamable HTTP). Start with a small hand-written spike to learn the current SDK. Then wire it to enabled tools from Redis cache (fallback to Postgres). API-key auth (hashed, shown once, revocable). Upstream API auth (encrypted credentials). SSRF protection + timeouts + response size limits reusing the helper from Phase 1.
*Done when:* MCP Inspector connected to `/mcp/petstore` lists enabled tools and a `tools/call` returns real upstream data.

**Phase 3: Rate Limiting and Logging**
Redis sliding-window rate limiting per API key. Gateway pushes log event to BullMQ (never blocks request). Worker writes ToolCallLog and updates UsageRollup. Sensitive fields masked.
*Done when:* exceeded limit returns a clear MCP error; every call appears in Postgres within seconds. Integration tests for both.

**Phase 4: Analytics Dashboard**
Call volume over time, top tools, error rate, p50/p95 latency, recent calls table with detail view. Charts using a lightweight library.
*Done when:* dashboard shows real data from seeded/test calls.

**Phase 5: Playground, Connection Instructions, Polish, Deploy**
Playground (schema-driven form → raw upstream request/response). Connection instructions page (MCP Inspector, Claude, Cursor, VS Code). Empty, loading and error states throughout. Playwright tests for the main flow. Free deployment guide (Vercel for `web`, free VM or Cloudflare Tunnel for gateway + worker + Redis, Neon for Postgres). Live deployment.
*Also in this phase (carried over from Phase 2):* give `@mcp-gateway/openapi-tools` a lightweight runtime entry (request map, request build, agent schema) so the gateway no longer loads `swagger-parser` at startup, and slim the gateway Docker image.
*Done when:* someone new can follow the README and get everything running end-to-end.

## 10. Working rules for Claude Code

- Ask before adding a dependency that is not in the stack table, and explain why it is needed.
- Prefer simple, readable code over clever abstractions. This codebase will be read by interviewers.
- Write tests alongside features, not at the end. Pure logic (`openapi-tools`, `crypto`, rate limiter) needs thorough unit tests.
- Keep `docs/DECISIONS.md` updated with one short entry per significant technical choice.
- If a requirement here is unclear or conflicts with how the current MCP SDK works, stop and ask instead of guessing.
- Never weaken a security requirement to make something work.
