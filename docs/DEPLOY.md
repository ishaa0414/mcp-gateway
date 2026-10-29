# Deploying Phase 5b (₹0 budget)

Four free-tier accounts, no credit card charges if you stay on each platform's free plan:

| Piece | Platform | Region |
|---|---|---|
| Dashboard (`apps/web`) | Vercel (Hobby) | Singapore (`sin1`, see `apps/web/vercel.json`) |
| Postgres | Neon (free) | Singapore |
| Gateway (`apps/gateway`) | Render (free web service) | Singapore |
| Redis | Upstash (free) | Singapore |
| Keep-warm ping | UptimeRobot (free) | — |

Everything is pinned to Singapore so the gateway's Postgres and Redis round trips, and the dashboard's calls to the gateway, stay in-region.

**No worker is deployed.** Render's free tier has no background-worker plan, and BullMQ's Redis polling would burn through Upstash's free command quota while idle. Set `LOG_SINK=direct` on the gateway instead: it writes call-log batches straight to Postgres and purges old rows itself, with no queue and no `apps/worker` process (see `.env.example`'s "Call logging" section, and the CI step added for this — `.github/workflows/ci.yml`, "Starts with LOG_SINK=direct (no worker) and still answers /ready" — which starts the gateway image this exact way with no worker container anywhere in that job).

**No GitHub OAuth.** `AUTH_GITHUB_ID`/`AUTH_GITHUB_SECRET` are optional (`apps/web/src/lib/env.ts:9-10`) and are left unset; sign in with email/password only.

## 1. Provision the services

1. **Neon**: create a project in the Singapore region. Note both connection strings it gives you — the pooled one (`DATABASE_URL`, used by every app at runtime) and the direct one (used only for the one-off migration step below, since `prisma migrate deploy` should not run through a connection pooler).
2. **Upstash**: create a Redis database in the Singapore region (free tier). Note its connection URL (`REDIS_URL`).
3. **Render**: create a free Web Service from this repo, Docker runtime, pointing at `apps/gateway/Dockerfile` (build context: the repo root — Render's "Root Directory" stays blank). Region: Singapore.
4. **Vercel**: import this repo as a project rooted at `apps/web` (Hobby plan). `apps/web/vercel.json` already pins its functions to `sin1`.

## 2. Generate secrets

```bash
openssl rand -hex 32   # AUTH_SECRET
openssl rand -hex 32   # ENCRYPTION_KEY (must be exactly 64 hex chars)
openssl rand -hex 32   # PLAYGROUND_SECRET (same value on both web and gateway)
```

## 3. Environment variables

**Gateway (Render):** `DATABASE_URL` (Neon, pooled), `REDIS_URL` (Upstash), `ENCRYPTION_KEY`, `LOG_SINK=direct`, `PLAYGROUND_SECRET`. Render assigns `PORT` itself — do not set it.

**Web (Vercel, Production environment):** `AUTH_SECRET`, `AUTH_URL` (the Vercel production URL), `DATABASE_URL` (Neon, pooled), `REDIS_URL` (Upstash), `ENCRYPTION_KEY`, `PLAYGROUND_SECRET` (same value as the gateway's), `GATEWAY_PUBLIC_URL` (the Render URL).

## 4. Migrate, then deploy

Order: **migrate → deploy gateway → deploy web.** There is no production seed step — see "Your first project" below.

1. From your own machine, run the migration once against Neon's **direct** (non-pooled) connection string:
   ```bash
   DATABASE_URL="<neon-direct-url>" pnpm db:migrate:deploy
   ```
2. Deploy the gateway (Render deploys on push, or trigger manually).
3. Deploy the dashboard (Vercel deploys on push).

## 5. Your first project (no production seed)

`packages/db/prisma/seed.ts` creates `demo@example.com` with **no password at all** (the `create` call sets no `password` field, and the schema's `password` column is nullable — `packages/db/prisma/schema.prisma:18`). That account cannot sign in through credentials; running it in production would leave a Petstore project no one can reach. Don't run `pnpm db:seed` against the production database.

Instead:
1. Sign up through the dashboard's own UI with your own email and password.
2. Import the Petstore spec (`https://petstore3.swagger.io/api/v3`) as a new project, the way any real user would.
3. Optionally, fill it with realistic analytics: `seed-analytics` already targets one project by slug, not just the dev fixture — `packages/db/src/analytics-seed.ts:198` takes `options.projectSlug`, and the CLI already exposes it (`packages/db/prisma/seed-analytics.ts:11,18`, `--project <slug>`). It refuses to run unless `NODE_ENV` is not `production` and the database host is `localhost`/`127.0.0.1`/`::1` (`assertSeedAllowed`, `packages/db/src/analytics-seed.ts:21-34`), so point it at Neon through a local SSH/port-forward if you want seeded data on the hosted database, or just skip this step. It's idempotent either way — it deletes its own previously-seeded rows for that project (matched by an `id` prefix of `seed_<projectId>_`) before writing new ones, so re-running it never duplicates data (`packages/db/src/analytics-seed.ts:227`).

## 6. Keep-warm

UptimeRobot, HTTP(s) monitor, `GET https://<render-url>/health`, every 5 minutes. `/health` is liveness only — no Postgres, no Redis (`apps/gateway/src/app.ts`) — so this ping keeps Render's free instance from spinning down without ever touching Neon, which would otherwise defeat Neon's autosuspend and its own cost savings.

Also set Render's **Health Check Path** to `/health` for the same reason: a transient Redis blip must not make Render restart an otherwise-healthy container (the gateway is designed to keep serving from Postgres when Redis is down — see the Redis-cache entry in `docs/DECISIONS.md`).

## 7. Post-deploy checklist

- [ ] **Measure the real cold-connect time before setting `DATABASE_CONNECT_TIMEOUT_MS`.** Let Neon's compute autosuspend (wait >5 minutes with no traffic), then hit `GET /ready` three times and read the Postgres check's logged duration from Render's logs (`apps/gateway/src/app.ts`'s `/ready` handler logs `{ ms }` via `app.log.info`). Set `DATABASE_CONNECT_TIMEOUT_MS` from the measured maximum plus headroom — do not guess a number from "a few seconds."
- [ ] **Confirm the pool's idle timeout stays under Neon's autosuspend.** `packages/db/src/index.ts:37-39` sets no `idleTimeoutMillis`, so it uses `pg-pool`'s own default of 10,000 ms (confirmed in the installed package: `pg-pool@3.14.0`'s `index.js:98-100`) against Neon's fixed 300,000 ms (5 min) autosuspend — our pool always drops an idle connection on its own side well before Neon's timer could, so a socket Neon has already closed is never reused. See the DECISIONS.md entry for this.
- [ ] **Verify the DB-unreachable error page on a Vercel Preview deployment — never on production.** Open a PR to get a Preview deployment, then in Vercel's dashboard scope these five env vars to the **Preview** environment (all five are required by `apps/web/src/lib/env.ts` with no default, so every one must be present for the app to boot past validation):

  | Variable | Preview value |
  |---|---|
  | `AUTH_SECRET` | same as Production |
  | `AUTH_URL` | this Preview deployment's actual URL (re-check after each redeploy) |
  | `DATABASE_URL` | a well-formed but unreachable URL, e.g. `postgresql://postgres:postgres@127.0.0.1:59999/mcpgateway` (syntactically valid, closed port — not a malformed string, so it fails as a connection error, not a parse error) |
  | `REDIS_URL` | the real Upstash URL (only `DATABASE_URL` needs to be broken for this check) |
  | `ENCRYPTION_KEY` | same as Production |

  Then **redeploy** (dashboard "Redeploy," or push a trivial commit to the PR branch) — a Preview env var change does not apply to a deployment that already exists — and visit the resulting Preview URL. Confirm it shows the generic error page (`apps/web/src/components/error-panel.tsx`) with no connection string, host or driver error text. Revert the `DATABASE_URL` override afterward.
