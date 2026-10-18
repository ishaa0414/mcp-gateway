# MCP Gateway — Claude Code Guide

## Project Summary

MCP Gateway is a SaaS platform that converts a team's REST API (described by an OpenAPI spec) into a hosted, production-ready MCP server that AI agents (Claude, Cursor, Copilot, etc.) can connect to. It targets API publishers who want to expose their service to AI agents in under 10 minutes. The MVP delivers tool curation, a hosted gateway, API-key auth, rate limiting, request logging, and an analytics dashboard — all at ₹0 cost.

## Tech Stack

| Area | Choice |
|---|---|
| Monorepo | pnpm workspaces + Turborepo |
| Dashboard | Next.js (App Router) + Tailwind CSS + shadcn/ui (`apps/web`) |
| Dashboard backend | Next.js route handlers / server actions |
| Auth | Auth.js v5 — GitHub OAuth + email/password (argon2) |
| Gateway | Node + Fastify + MCP SDK v2 (`@modelcontextprotocol/server` + `@modelcontextprotocol/node`), Streamable HTTP, stateless (`apps/gateway`) |
| Worker | BullMQ log consumer (`apps/worker`) |
| Database | PostgreSQL + Prisma (`packages/db`) |
| Cache / queues / rate limits | Redis |
| OpenAPI parsing | `@apidevtools/swagger-parser` (`packages/openapi-tools`) |
| Shared types + SSRF helper | Zod (`packages/shared`) |
| Tests | Vitest (unit/integration), Playwright (E2E) |
| Local infra | Docker Compose (Postgres + Redis) |
| CI | GitHub Actions |

## Phase Status

- **Phase 0: Foundation** ✅ Done (merged to main)
- **Phase 1: Auth, Projects, OpenAPI Import, Tool Builder** ✅ Done (merged to main)
- **Phase 2: Hosted MCP Server** ✅ Done (merged to main, #3)
- **Phase 3: Rate Limiting and Logging** ✅ Done (merged to main, #4)
- **Phase 4: Analytics Dashboard** ✅ Done (merged to main, #5)
- **Phase 5: Playground, Polish, Deploy** 🟡 In progress (5a: playground + connection guides; 5b: deploy + demo)

## Working Rules (from spec §10)

- Ask before adding a dependency not in the stack table, and explain why it is needed.
- Prefer simple, readable code over clever abstractions. This codebase will be read by interviewers.
- Write tests alongside features, not at the end. Pure logic (`openapi-tools`, `crypto`, rate limiter, SSRF helper) needs thorough unit tests.
- Keep `docs/DECISIONS.md` updated with one short entry per significant technical choice.
- If a requirement in the spec is unclear or conflicts with how the current MCP SDK works, stop and ask instead of guessing.
- Never weaken a security requirement to make something work.
- Never delete or modify files outside the repo without asking the user first (home folder, temp folders, tool config such as `~/.mcp-inspector`, other projects).
- Ask before starting, stopping or restarting Docker Desktop, containers or other system services, and before building or running images. Cleaning up afterwards does not make it okay to skip asking. If Docker or a service is down and the tests need it, say so and ask.
- Never run git checkout, git restore or git reset on files with uncommitted changes without asking. Use git stash if you need a clean tree.
- The Bash tool on Windows is Git Bash: write paths with forward slashes (`D:/mcp-gateway/...`) or quote them. An unquoted `D:\mcp-gateway\apps` loses its backslashes and creates a stray folder literally named `D:mcp-gatewayapps`.

Always read docs/SPEC.md before starting any phase.

## Running the tests locally

- Postgres and Redis must be up (`docker compose up -d`; ask before starting them). Then `pnpm test` from the root runs every package through Turborepo, in parallel.
- Each package that touches Postgres has its **own test database**, created and migrated by its vitest `global-setup.ts` (`prepareTestDatabase` in `@mcp-gateway/db/test-database`): `mcpgateway_test_web`, `mcpgateway_test_gateway`, `mcpgateway_test_worker`. Nothing to create by hand, in CI either. `DATABASE_URL_TEST` (default `.../mcpgateway_test`) is only the base name they are derived from; the plain `mcpgateway_test` database is no longer used.
- Never point two packages' tests at one database: the log-retention tests (`purgeOldLogs`) delete rows table-wide, with real and shifted clocks, and would remove another package's rows mid-run. A new package that needs Postgres gets its own suite name, not a shared database.
- Tests use Redis database 1 (the dev gateway uses 0). BullMQ queue names in tests carry a random suffix, so packages do not share queues.
- One package: `pnpm --filter @mcp-gateway/web test`.
