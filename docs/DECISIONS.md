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

### Tool edits are detected against a stored spec baseline
**Decision:** `Tool` stores `specName` / `specDescription` (what the spec last produced). A user edit is `name != specName`; re-import overwrites `name`/`description` only while they still equal the baseline, and always advances the baseline. `enabled` and `hiddenParams` are never part of an import write. `mergeTools` returns only the rows that changed, so identical specs report `0 updated` and `N unchanged`.
**Why:** The first design relied on a `userEdited` flag that no code ever stored or passed, and the unit tests fed it in by hand, so they passed while the real app silently reverted every edit. A baseline needs no flag to be kept in sync and survives edits made anywhere. Schemas are compared with an order-insensitive deep equal because Postgres JSONB reorders keys, which previously made every tool look "updated".

### Upstream base URL: always absolute, SSRF-checked on save
**Decision:** `servers[0].url` is resolved by `resolveBaseUrl` (variable defaults substituted; relative URLs resolved against the spec URL when imported by URL, left unset for file uploads). Every save path (create, Settings, import) goes through `assertPublicHttpUrl` (http/https only, no credentials, host must resolve to a public address, same blocklist as `ssrfFetch`). An import never overwrites a base URL that is already set.
**Why:** A relative value like `/api/v3` cannot be called, and a private host saved today becomes an SSRF at call time. Failing at save gives the user the reason immediately.

### Tailwind 4 needs the shadcn tokens registered in `@theme inline`
**Decision:** `globals.css` maps every `--background`, `--primary`, … variable to a `--color-*` token and defines `@custom-variant dark` on the `.dark` class.
**Why:** shadcn assumes Tailwind 3's `tailwind.config`. Under Tailwind 4 without the mapping, `bg-primary`, `bg-background`, `text-destructive` etc. compile to nothing, which made switches, dialogs and buttons look broken everywhere at once.

### `server-only` on the web DB wrapper plus a lint rule
**Decision:** `apps/web/src/lib/db.ts` imports `server-only`; ESLint forbids value imports of `@mcp-gateway/db` elsewhere in the web app (type imports allowed). The guard lives in the web app, not `packages/db`, which the gateway and worker run outside React.
**Why:** A client component pulling Prisma into the browser bundle fails the build instead of surfacing as a runtime error. Verified by importing the wrapper from a client page and watching the build fail.

### One PrismaClient per process, in every environment
**Decision:** The lazy `db` proxy always returns the same client (cached on `globalThis`).
**Why:** In production it built a new client per property access, so an interactive transaction began on one client and ran its queries on another ("Transaction not found") and each call leaked a connection pool. Development cached the client and hid it; only a production-build test found it.

### Tool names are unique per project, enforced by the database
**Decision:** `@@unique([projectId, name])` on `Tool` (all rows, including removed ones). The rename action and editor check it first for a friendly inline error; the index is the final word and a lost race is reported the same way. On import, names are assigned in priority order: names a tool already holds (user-chosen, unchanged, or belonging to a removed tool) are reserved first, then spec-derived names that moved, then new tools. A clashing spec name gets `_2`, `_3`, … (kept within 64 chars) and is listed in the import summary. Writes are ordered (park renamed rows on a placeholder, update, then create) because Postgres checks the index per statement.
**Why:** MCP clients address tools by name, so two tools with one name make one of them unreachable. The user's chosen name must never be taken from them by a later spec. A suffixed tool counts as "edited" afterwards (`name != specName`), which keeps re-imports stable instead of flip-flopping. The migration renames pre-existing duplicates (`_dupN`) so it cannot fail on old data.

### `middleware.ts` renamed to `proxy.ts` (Next.js 16)
**Decision:** Renamed per the installed Next 16 docs; the default export and matcher are unchanged. Re-verified in a browser: signed-out redirect, sign-in, `/api/health` public.
**Why:** `middleware` is deprecated. Note the proxy now runs on the Node.js runtime by default (the old middleware ran on edge), so the "edge-safe" wording in our comments was updated. `auth.config.ts` stays free of Prisma/argon2 so the proxy does not depend on the database layer.

### `ssrfFetch` hardening for the gateway
**Decision:** Added JSON/raw request bodies (POST/PUT/PATCH only), one overall deadline (`timeoutMs`, default 15 s, covering DNS, connect, redirects and the body read), a `followRedirects` switch, and blocks for 224.0.0.0/4, 240.0.0.0/4, 198.18.0.0/15 and 64:ff9b::/96. IPv6 checks now work on parsed groups, so alternative spellings of the same address cannot slip past, and unparseable addresses fail closed. Errors carry a `code` (`BLOCKED`, `TIMEOUT`, `TOO_LARGE`, `REDIRECT`, `INVALID_REQUEST`).
**Why:** The gateway forwards agent-supplied data and upstream credentials. Redirects used to re-send every header to any host, which would leak an upstream API key; now only a small allow-list of headers crosses origins, a body is never forwarded cross-origin, and 301/302/303 turn a POST into a GET like a browser. Oversized responses are abandoned instead of drained to the end, and the HTTPS client is closed only after the body is read. Destroying an undici body emits an `error` event, so a listener is attached first; without it Node treats it as an uncaught exception and the process dies.

### MCP SDK v2 (`@modelcontextprotocol/server` + `node`), stateless serving
**Decision:** The gateway uses the v2 SDK (`@modelcontextprotocol/server` 2.3.1, `@modelcontextprotocol/node` 2.1.1), the low-level `Server` with `setRequestHandler('tools/list' | 'tools/call')`, and `createMcpHandler` with a fresh server per request: no sessions, `legacy: 'stateless'` (the default) so clients on the 2025 handshake are served too. `@modelcontextprotocol/sdk` 1.32.1 is a dev dependency only, used by a test proving older-protocol clients can list and call tools. The stack tables in `SPEC.md` and `CLAUDE.md` were updated.
**Why:** `@modelcontextprotocol/sdk` is now the v1 maintenance line (spec 2025-11-25); v2 is the current stable release and the one MCP Inspector 2.9 is built on. Stateless fits a multi-tenant gateway on free hosts that restart often, scales without sticky sessions, and nothing here needs server-initiated messages. Verified with a spike (`apps/gateway/examples/`): the v2 client (legacy, `auto` and pinned-2026 negotiation), the v1 client and Inspector's CLI all list and call tools against the same server. The low-level server does not validate arguments, so the gateway validates them with the SDK's own Ajv entry (`@modelcontextprotocol/server/validators/ajv`), which means no direct `ajv` dependency.

### One description of a tool's arguments, shared by schema and request
**Decision:** `describeOperation` in `openapi-tools` produces, per operation, each argument's schema *and* where it goes on the wire (path, query, header, cookie, JSON/form body property, or whole body). `extractTools` builds the input schema from it and the gateway builds the HTTP request from the same description via `buildRequestMap` + `buildRequest`; a test asserts the two agree for every operation in the fixtures. The map is derived from the stored spec rather than saved per tool. Arguments that share a name across locations (a path `id` and a body `id`) are no longer merged: path > query > header > cookie > body, and a later clash is renamed with its location (`body_id`, then `_2`, …). `toAgentSchema` (hidden parameters removed) moved from the dashboard component into the package so the dashboard preview and the gateway's `tools/list` cannot differ.
**Why:** The old extractor keyed arguments by name alone, so a clash silently dropped one of them, and nothing recorded which arguments were path, query or body, which the gateway needs. Deriving instead of storing avoids a migration and a second copy that could go stale. Re-importing an existing project rewrites a stored schema that differs (it counts as "updated") while keeping the user's edits. Limits: object-valued query parameters are sent as JSON, cookie parameters go in one `Cookie` header, and multipart/XML bodies are not supported. Path values of `.` or `..` are rejected because they would be resolved as dot-segments and escape the intended path.

### Gateway request path: authenticate first, one stateless handler, errors as tool results
**Decision:** `POST /mcp/:projectSlug` authenticates before the SDK sees the request: `Authorization: Bearer <key>`, SHA-256 hash looked up (Redis, then Postgres), the key's project must match the slug, and every failure (missing, malformed, unknown, revoked, another project's key, unknown slug) returns the same 401 so slugs cannot be enumerated. One SDK handler is built at startup; the authenticated project travels to its per-request server factory through `authInfo`, so nothing is shared between tenants. `GET`/`DELETE` return 405. A tool call validates arguments with the SDK's Ajv entry, merges hidden values last so they always win, builds the request, adds the credential, and calls `ssrfFetch` with no redirects, a 15 s deadline and a 1 MB cap. Every failure (validation, upstream 4xx/5xx, timeout, oversize, redirect, blocked host, unreachable) is an `isError` result with fixed wording, not a protocol error or a crash; an unknown, disabled or removed tool is the same protocol error (`-32602`).
**Why:** The SDK handler deliberately does no authentication, so it must be placed behind our check. Returning failures as results lets the model read and correct them, and a thrown error would hide them behind a generic one. Messages never contain the request URL or headers, and all outgoing text is scrubbed of the credential in its raw, URL-encoded and base64 forms, because upstream error pages often echo the request (verified, including on successful responses).

### Redis is a cache, not a dependency; invalidation is explicit
**Decision:** Per-project config (`mcp:cfg:<slug>`: base URL, encrypted credential, enabled tools with their request maps) and API key lookups (`mcp:key:<hash>`, with a 10 s negative entry) live in Redis. Every Redis failure is a cache miss plus a warning, so an outage makes the gateway slower, not down. Entries expire on their own (config 5 min, keys 30 s), and the dashboard deletes them on every edit through helpers in `packages/shared`. `lastUsedAt` is written at most once per key per 5 minutes per instance, in memory and off the request path.
**Why:** The spec asks for a Redis cache with a Postgres fallback. The TTLs bound staleness if an invalidation is lost (a revoked key can work for at most 30 s then), and the config cache holds the credential still encrypted so Redis never sees plaintext. A shared-Redis throttle for `lastUsedAt` would make a cache outage cost a write per call; the dashboard only shows minutes.

### `DATABASE_POOL_MAX`: an explicit cap on Postgres connections
**Decision:** `packages/db` reads an optional `DATABASE_POOL_MAX` (default: the pg driver's 10). Test setups set it to 3.
**Why:** A full `pnpm test` runs a dozen vitest workers, each with its own client, against a Postgres limited to 100 connections; one run hit "Unable to start a transaction in the given time". The same limit matters in production: free-tier hosted databases allow few connections, and each gateway or web process opens its own pool.

### Dashboard: keys shown once, credentials write-only, cache invalidation fails open
**Decision:** An API key is generated server-side and returned in one response; only its SHA-256 hash and a short prefix are stored, and the reveal dialog cannot be dismissed by Escape or a stray click. Upstream credentials are write-only: the browser receives only `{ type, names, hasValue }`, shows `••••••••` and a Replace button, and an empty value means "keep the stored secret", but only when the kind is unchanged (a secret is never carried over to a different scheme). Header names are validated as RFC 9110 tokens and gateway-controlled headers (Host, Content-Length, …) are refused; values containing control characters are refused to stop header injection. Every action that changes what the gateway serves clears the right Redis key through `CacheInvalidator`, which logs a warning and carries on if Redis is down, then stops trying for 30 s. The rate limit is stored and shown on each key (enforced since Phase 3, see below).
**Why:** Showing a secret once is the only way to keep it unrecoverable. A credential that can be read back is a credential that can leak through the browser, logs or screenshots. Redis only caches what Postgres already holds, so a failed invalidation must not fail an edit that has already been saved; the cache TTLs (5 min config, 30 s keys) bound the damage, and the short timeouts mean an outage costs one brief delay rather than one per click.

### The gateway ships as a standalone image built with `pnpm deploy`
**Decision:** `apps/gateway/Dockerfile` (build context: the repo root) installs only what the gateway needs (`--filter @mcp-gateway/gateway...`), compiles the workspace packages in dependency order, and uses `pnpm deploy --prod` to extract a self-contained folder into a clean `node:22-slim` runtime stage. It runs as the non-root `node` user with node as PID 1 (the gateway drains on SIGTERM), has a `/health` healthcheck on whatever port `PORT` names, contains no source, tests or `.env`, and is configured only by environment variables. It does not run migrations. CI builds the image and checks all of that, in a job that runs in parallel with the main one.
**Why:** The gateway must run anywhere (Render, Koyeb, a VM) from environment variables alone, with no reliance on a repo checkout. `pnpm deploy` is the supported way to produce that folder from a workspace; the multi-stage layout keeps compilers and dev dependencies out of the runtime. Known cost: the image is about 820 MB uncompressed, mostly Prisma's client and the tooling it pulls in as peers, and a cold build takes minutes because pnpm 12 verifies every lockfile entry against the registry's release-age policy (a supply-chain protection we leave on).

### Gateway dev runs under `node --watch`, and startup is guarded so it can never fail silently
**Decision:** The gateway `dev` script is `node --watch --import tsx src/index.ts` instead of `tsx watch`. `src/index.ts` is now a tiny entry that loads `main.ts` through a dynamic import inside `runStartup` (`src/startup.ts`): any import or startup error is logged as `[gateway] Gateway failed to start: ...` and the process exits 1, and a watchdog (`GATEWAY_STARTUP_TIMEOUT_SECONDS`, default 60) logs a clear message and exits 1 if the server is not listening in time.
**Why:** Under Turbo on Windows, `tsx watch` never finished loading the gateway's large import graph (tested to 240 s) and printed nothing, so `pnpm dev` showed no "Server listening" line and no error. `tsx src/index.ts` and `node --watch --import tsx` start in about 8 s in the same setup and still restart on edits. ES module imports are evaluated before any code in the importing file, so the guard had to sit in a file with no heavy imports. Redis and Postgres are not awaited before `listen`, so they were not the cause.

### Gateway dev restarts on content changes only, via a small runner (supersedes `node --watch`)
**Decision:** `pnpm dev` runs `apps/gateway/scripts/dev.mjs`, which starts `node --import tsx src/index.ts` and restarts it only when the content hash of a watched file changes. Watched: `apps/gateway/src`, the `dist` folders of `shared`, `crypto`, `db` and `openapi-tools`, and the root `.env`. Events whose content is unchanged are ignored; real edits are debounced to one restart.
**Why:** On Windows with NTFS last-access updates enabled (the default), the first read of a file in an hour is reported as a "change" event. `node --watch` restarts on any event, so the web app compiling a page, the worker starting, or the gateway reading its own files restarted the gateway in a loop (`--watch-path` was worse: its watchers exist before the gateway's own startup reads). Watching content instead of events is immune to this. Cost: about 80 lines of script and no new dependency; a package's `src` edit still needs a rebuild of its `dist`, as before.

### Tool annotations come from the HTTP method; 401s say "API key", not OAuth
**Decision:** `tools/list` returns annotations derived from the upstream method (`annotationsForMethod`): GET/HEAD are read-only; DELETE is destructive and idempotent; PUT is idempotent; POST/PATCH change state and are not idempotent; every tool is open-world. The 401 body reads "API key missing, invalid or revoked…" (one message for all causes, so project slugs still cannot be probed), and unknown routes, including OAuth discovery URLs such as `/.well-known/oauth-protected-resource`, get a JSON 404 straight away. No OAuth is implemented.
**Why:** Without annotations, clients assume the worst, so the Inspector showed a GET as "Destructive". After a 401 the Inspector tried OAuth discovery and reported a confusing "OAuth Authentication Failed"; an explicit, fast 404 and a message that names the API key point people at the real problem. Annotations are hints for UIs only, never a security control.

---

## Phase 3

### Rate limiting: exact sliding-window log in one Lua script, `tools/call` only
**Decision:** Each API key's limit (`ApiKey.rateLimitPerMin`, tool calls per rolling 60 s) is enforced with a Redis sorted set per key (`mcp:rl:<apiKeyId>`): one member per accepted call, scored by its time. A single Lua script trims old members, counts, and either rejects (returning the exact seconds until enough of the oldest calls leave the window) or adds the call and sets the expiry, so concurrent requests, even from several gateway instances, cannot pass the check together. Only `tools/call` messages count, a JSON-RPC batch counts once per `tools/call` in it, and rejected calls are not recorded. The check runs after authentication and before the SDK sees the request, so a rejected call never reaches the upstream and unauthenticated traffic cannot create counters. The answer is HTTP 429 (kept as a status, not a 200 with `isError`) with `Retry-After`, `RateLimit-Limit/Remaining/Reset` and a JSON-RPC error body (code -32029) whose message names the limit and the wait.
**Why:** A fixed window lets a caller double the limit across a boundary, and an approximate counter gives only a guessed `Retry-After`; the exact log is O(limit) memory per active key, bounded by the 10,000 cap, and one command per call. The handshake (`initialize`, `tools/list`) repeats on every stateless connection and never reaches the upstream, so counting it would spend quota on overhead. Gap accepted: `tools/list` is not limited in this phase (it is served from cache). The script takes the time from the gateway instead of Redis `TIME` so it contains no non-deterministic command, which some hosted Redis plans refuse; a few milliseconds of skew between instances do not matter against 60 s. MCP clients (SDK v1 and v2) print the response body, not the status line, so the wait time has to be in the message text; the status and headers are for HTTP-aware callers and browsers (`retry-after` and `ratelimit-*` are exposed through CORS). A 429 makes the client throw, so the host application sees it rather than the model; that was chosen over `200 + isError` on purpose.

### Rate limiting fails open when Redis is down (no local fallback)
**Decision:** If the Lua call fails, the call is allowed. A circuit breaker (5 s) then skips Redis entirely so a hung Redis does not add its command timeout to every call, and one warning is logged per breaker window. There is no in-memory fallback limiter.
**Why:** The gateway already treats Redis as a cache, not a dependency (see "Redis is a cache"), so an outage should slow it down, not stop every customer's agents. **Trade-off:** while Redis is unreachable nothing is limited, so a key can send as many calls as the gateway and the upstream can take, and the publisher's API is protected only by its own limits. A per-instance in-memory limiter would cap that at N times the number of instances, but it is a second implementation of the algorithm to keep consistent and test, which this phase chose not to carry. The warning log and the breaker make an outage visible and bounded in cost.

