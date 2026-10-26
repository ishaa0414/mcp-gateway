import { execFileSync, execSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { testDatabaseUrl } from '@mcp-gateway/db/test-database'

// Everything the three servers and the tests need to agree on. The e2e stack never touches the development one:
// its own ports, its own Postgres database (mcpgateway_test_e2e), Redis database 3, and fresh random secrets.
export const WEB_PORT = 3110
export const GATEWAY_PORT = 4110
export const FIXTURE_PORT = 4210
export const REDIS_DB = 3

export const WEB_URL = `http://127.0.0.1:${WEB_PORT}`
export const GATEWAY_URL = `http://127.0.0.1:${GATEWAY_PORT}`
export const FIXTURE_URL = `http://127.0.0.1:${FIXTURE_PORT}`

export const REPO = resolve(fileURLToPath(new URL('.', import.meta.url)), '../../..')
/** The production build of the dashboard goes here, so it can never overwrite what `next dev` uses in `.next`. */
export const WEB_DIST_DIR = '.next-e2e'

/**
 * Refuses anything that is not the e2e database on a local Postgres and Redis database 3 on a local Redis:
 * the run flushes that Redis database and creates users and projects in that Postgres database.
 */
export function assertSafeTargets(databaseUrl: string, redisUrl: string): void {
  const db = new URL(databaseUrl)
  const dbName = decodeURIComponent(db.pathname.replace(/^\//, ''))
  if (!dbName.endsWith('_test_e2e')) throw new Error(`e2e: the database must be named *_test_e2e, got "${dbName}"`)

  const redis = new URL(redisUrl)
  if (!['localhost', '127.0.0.1'].includes(redis.hostname)) throw new Error(`e2e: Redis must be local, got host "${redis.hostname}"`)
  if (redis.pathname !== `/${REDIS_DB}`) throw new Error(`e2e: Redis must use database ${REDIS_DB}, got "${redis.pathname}"`)
}

/**
 * Fails with a clear message if something already listens on one of our ports. Without it Playwright polls the other
 * program's answers (a 404, say) until its timeout. Done in a child process because the config must stay synchronous.
 */
function assertPortsFree(): void {
  const script = "const net=require(\"node:net\");const s=net.createServer();s.once(\"error\",()=>process.exit(1));s.listen(Number(process.argv[1]),\"127.0.0.1\",()=>s.close(()=>process.exit(0)))"
  for (const port of [WEB_PORT, GATEWAY_PORT, FIXTURE_PORT]) {
    try {
      execFileSync(process.execPath, ['-e', script, String(port)], { stdio: 'ignore' })
    } catch {
      throw new Error(`e2e: port ${port} is already in use; stop whatever listens on it (the e2e stack uses ${WEB_PORT}, ${GATEWAY_PORT} and ${FIXTURE_PORT})`)
    }
  }
}

/** Reads a secret from the environment, or makes one and puts it there, so the servers and the test workers share it. */
function secret(name: string): string {
  return (process.env[name] ??= randomBytes(32).toString('hex'))
}

/**
 * Checks the targets, creates and migrates the e2e database, and fixes the secrets. Runs once per `playwright test`:
 * the test workers inherit the environment this sets, and the marker stops them from repeating it.
 */
export function prepareEnvironment(): void {
  const databaseUrl = testDatabaseUrl('e2e')
  const redisUrl = process.env['E2E_REDIS_URL'] ?? `redis://127.0.0.1:6379/${REDIS_DB}`
  assertSafeTargets(databaseUrl, redisUrl)

  process.env['DATABASE_URL'] = databaseUrl
  process.env['REDIS_URL'] = redisUrl
  secret('AUTH_SECRET')
  secret('PLAYGROUND_SECRET')
  secret('ENCRYPTION_KEY')

  if (process.env['E2E_PREPARED']) return
  process.env['E2E_PREPARED'] = '1'
  assertPortsFree()
  execSync('pnpm prisma migrate deploy', { cwd: resolve(REPO, 'packages/db'), env: { ...process.env, DATABASE_URL: databaseUrl }, stdio: 'pipe' })
}

/** Variables every process of the stack gets explicitly, so none falls back to the development values in the root .env. */
function shared(): Record<string, string> {
  return {
    DATABASE_URL: process.env['DATABASE_URL']!,
    REDIS_URL: process.env['REDIS_URL']!,
    ENCRYPTION_KEY: process.env['ENCRYPTION_KEY']!,
    PLAYGROUND_SECRET: process.env['PLAYGROUND_SECRET']!,
    TOOL_CALL_TIMEOUT_MS: '5000',
    // Production fails a database connect after 5 s (packages/db). This run is not a test of that, and a starved laptop
    // (the Playground flow failed once in 12 on a connect that took longer) should not turn it into a flaky failure.
    DATABASE_CONNECT_TIMEOUT_MS: '30000',
  }
}

export function webEnv(): Record<string, string> {
  return {
    ...shared(),
    // Playwright sets NODE_ENV=test for what it starts; a production build served that way answers 404.
    NODE_ENV: 'production',
    NEXT_DIST_DIR: WEB_DIST_DIR,
    AUTH_SECRET: process.env['AUTH_SECRET']!,
    AUTH_URL: WEB_URL,
    GATEWAY_PUBLIC_URL: GATEWAY_URL,
    GATEWAY_INTERNAL_URL: GATEWAY_URL,
    // The production web build compiles the private-address allowance out; this only keeps the root .env from setting it.
    ALLOW_PRIVATE_UPSTREAMS: 'false',
  }
}

/**
 * NODE_ENV=development and ALLOW_PRIVATE_UPSTREAMS=true are the documented way to let the gateway call a local upstream
 * (packages/shared/src/ssrf-fetch.ts); the schema refuses them together with NODE_ENV=production. See docs/DECISIONS.md.
 */
export function gatewayEnv(): Record<string, string> {
  return {
    ...shared(),
    NODE_ENV: 'development',
    ALLOW_PRIVATE_UPSTREAMS: 'true',
    HOST: '127.0.0.1',
    PORT: String(GATEWAY_PORT),
    GATEWAY_PORT: String(GATEWAY_PORT),
    LOG_SINK: 'direct',
  }
}
