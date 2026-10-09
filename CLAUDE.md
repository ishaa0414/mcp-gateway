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
- **Phase 2: Hosted MCP Server** ✅ Implemented on `phase-2-mcp-gateway`, awaiting review (not merged)
- **Phase 3: Rate Limiting and Logging** — future
- **Phase 4: Analytics Dashboard** — future
- **Phase 5: Playground, Polish, Deploy** — future

## Working Rules (from spec §10)

- Ask before adding a dependency not in the stack table, and explain why it is needed.
- Prefer simple, readable code over clever abstractions. This codebase will be read by interviewers.
- Write tests alongside features, not at the end. Pure logic (`openapi-tools`, `crypto`, rate limiter, SSRF helper) needs thorough unit tests.
- Keep `docs/DECISIONS.md` updated with one short entry per significant technical choice.
- If a requirement in the spec is unclear or conflicts with how the current MCP SDK works, stop and ask instead of guessing.
- Never weaken a security requirement to make something work.
- Never delete or modify files outside the repo without asking the user first (home folder, temp folders, tool config such as `~/.mcp-inspector`, other projects).
- The Bash tool on Windows is Git Bash: write paths with forward slashes (`D:/mcp-gateway/...`) or quote them. An unquoted `D:\mcp-gateway\apps` loses its backslashes and creates a stray folder literally named `D:mcp-gatewayapps`.

Always read docs/SPEC.md before starting any phase.
