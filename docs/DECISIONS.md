# Technical Decisions

Short log of significant technical choices and their rationale.

---

## Phase 0

### Prisma 7.10.0 over 8.x-RC
**Decision:** Pin `prisma@7.10.0` (`prev` dist-tag), not `8.0.0-rc.*` (`latest` dist-tag).
**Why:** Prisma 8 is in release-candidate status. A portfolio codebase seen by interviewers should not depend on an RC. 7.10.0 is the last stable release.

### `@prisma/adapter-pg` driver adapter
**Decision:** Use `PrismaPg({ connectionString })` from `@prisma/adapter-pg` instead of the default Prisma engine.
**Why:** The driver adapter gives explicit control over the `pg.Pool`, is compatible with edge runtimes, and is the direction Prisma is investing in for future versions. Required by Prisma 7's recommended setup for PostgreSQL.

### TypeScript ~6.0.3 (not 7.x)
**Decision:** Pin TypeScript to `~6.0.3`.
**Why:** `typescript-eslint@8.x` only supports TypeScript `<6.1`. TypeScript 7 (when released) will require a matching `typescript-eslint` upgrade.

### `typescript-eslint` single package
**Decision:** Use the unified `typescript-eslint` package, not the old separate `@typescript-eslint/parser` + `@typescript-eslint/eslint-plugin`.
**Why:** The unified package is the current recommended approach as of ESLint 9+ and `typescript-eslint` v8+. Fewer packages, single version to manage.

### ESLint flat config (`eslint.config.mjs`)
**Decision:** Use the ESLint flat config format, not the legacy `.eslintrc.*` format.
**Why:** ESLint 9+ deprecated the legacy config format. Flat config is the default and the only supported format in ESLint 10.

### Tailwind CSS 4.x over 3.x
**Decision:** Use Tailwind CSS 4 with `@tailwindcss/postcss`.
**Why:** Next.js 16 ships with Tailwind 4 support. Tailwind 4 is CSS-first (no `tailwind.config.ts` needed for basic usage), which reduces configuration surface.

### Zod 4.x
**Decision:** Use Zod `^4.6.5`.
**Why:** Zod 4 is the current stable major with improved performance and a cleaner API. No reason to use 3.x in a new project.

### `node:crypto` for encryption (no external library)
**Decision:** Implement AES-256-GCM using Node's built-in `node:crypto` module, no third-party crypto library.
**Why:** Eliminates supply-chain risk in security-critical code. Node's crypto module is well-audited and maintained. The implementation is straightforward for AES-256-GCM.

### Auth.js tables in Phase 0 Prisma schema
**Decision:** Include `Account`, `Session`, and `VerificationToken` tables in the initial migration alongside the app models.
**Why:** Auth.js (NextAuth) needs these tables. Adding them now avoids a schema-breaking migration in Phase 3 when auth is wired up. The `@auth/prisma-adapter` v2 schema is stable.

### BullMQ 6.x
**Decision:** Use BullMQ `^6.3.11`.
**Why:** Current stable major. BullMQ 6 uses `ioredis` 5.x which is the widely-used Redis client in the ecosystem. No breaking changes from BullMQ 5 for our use case.

---

## Phase 1

### `@node-rs/argon2` for password hashing
**Decision:** Use `@node-rs/argon2` instead of `bcrypt` or `argon2`.
**Why:** Provides pre-built native binaries — no compiler toolchain needed, works on Windows without MSVC. Argon2id is the current OWASP-recommended password hashing algorithm. `@node-rs/argon2@2.x` ships binaries for Node 22 + all major platforms.

### undici + custom DNS lookup for SSRF protection
**Decision:** Use `undici` with a pre-connect DNS validation hook instead of a fetch wrapper or a WAF.
**Why:** Validate every resolved IP against the RFC 1918 / CGNAT / link-local / IPv6 blocklist before connecting. Rewrite the URL to use the validated IP and set `Host` / SNI headers explicitly. This prevents DNS rebinding attacks. Manual redirect following (max 3 hops, re-validate each hop) closes TOCTOU gaps. The approach is defence-in-depth at the library level.

### JWT-only sessions (no database Session rows)
**Decision:** Use `session: { strategy: 'jwt' }` for all providers including GitHub OAuth.
**Why:** The Credentials provider requires JWT sessions (database sessions require per-request DB reads for every RSC). JWT is simpler operationally and sufficient for Phase 1. The `Session` table is retained in the schema for the Auth.js adapter's schema compliance.

### No auto-linking of GitHub OAuth to password accounts
**Decision:** If a GitHub OAuth login's email matches an existing password account, return an error instead of auto-linking.
**Why:** Auto-linking can allow account takeover: an attacker who controls a GitHub account with the target email could hijack a password account. The user is shown a clear error message and instructed to sign in with their password.

### Project slug globally unique, immutable
**Decision:** `slug` is globally unique (enforced by `@@unique` in Prisma), validated as `^[a-z0-9-]{3,48}$`, and not editable after creation.
**Why:** The slug is part of the public MCP endpoint URL (`/mcp/:slug`). Changing it would break all existing connections. Global uniqueness avoids URL collisions across users.

### `removedAt` soft-delete on Tool
**Decision:** Add `removedAt DateTime?` to Tool instead of hard-deleting when an operation disappears from a re-imported spec.
**Why:** Preserves user edits and tool call logs. Users can see which tools were removed and the badge ("Removed from spec") makes the state visible. Re-adding the operation to the spec clears `removedAt`.

### Separate `mcpgateway_test` database for integration tests
**Decision:** Integration tests use `DATABASE_URL_TEST` (defaults to `mcpgateway_test` DB), never `DATABASE_URL`.
**Why:** Prevents test runs from corrupting development data. Vitest global setup runs `prisma migrate deploy` on the test DB before tests run, keeping schema in sync.

---

### pnpm `onlyBuiltDependencies` / `allowBuilds` in `pnpm-workspace.yaml`
**Decision:** Explicitly allowlist `@prisma/engines`, `esbuild`, `msgpackr-extract`, and `prisma` for build scripts.
**Why:** pnpm 12 blocks all build scripts by default for supply-chain security. These four packages are known to need native compilation (Prisma query engine, esbuild binary, msgpackr native module). The `pnpm-workspace.yaml` approach is the pnpm 12-recommended way to approve builds without per-developer prompts.

### Root `.env` loaded per app at runtime; validated with Zod at startup
**Decision:** Library packages (`packages/db`) never load `.env`. Each app loads the root `.env` itself — web in `src/instrumentation-node.ts` via `@next/env`, gateway/worker in `src/env.ts` via `dotenv` — then validates it with a per-app Zod schema through the shared `validateEnv`, which throws one error listing every missing/invalid variable and exits.
**Why:** Next.js only reads `.env` from `apps/web`. Calling `loadEnvConfig` from `next.config.ts` looked right but only mutates the CLI process — verified on Next 16 + Turbopack that the server runtime never saw those values. `register()` in instrumentation is documented to finish before any request is served, and middleware reads the same `process.env`, so one load there covers dev and `next start`. CI previously passed only because it set the variables in the job env; a smoke step now unsets `DATABASE_URL`/`AUTH_SECRET` and checks `/api/health` (public, `SELECT 1`), `/api/auth/providers` and the signed-out redirect.
