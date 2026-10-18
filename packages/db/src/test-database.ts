import { execSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * One Postgres database per test suite, so one package's tests can never read, count or delete
 * another package's rows. Imported by the `global-setup.ts` of each package that touches Postgres,
 * through the `@mcp-gateway/db/test-database` subpath (this file does not load the Prisma client,
 * so it cannot create one against the wrong database).
 *
 * `DATABASE_URL_TEST` names the *family*: `.../mcpgateway_test` gives `mcpgateway_test_web`,
 * `mcpgateway_test_gateway` and so on. The result can therefore never be the development database,
 * whatever `DATABASE_URL_TEST` is set to.
 */

export const DEFAULT_TEST_DATABASE_URL = 'postgresql://postgres:postgres@localhost:5432/mcpgateway_test'

const SUITE_NAME = /^[a-z][a-z0-9]*$/

/** The URL of `suite`'s own database, derived from `base` (default: `DATABASE_URL_TEST`). */
export function testDatabaseUrl(suite: string, base: string = process.env['DATABASE_URL_TEST'] ?? DEFAULT_TEST_DATABASE_URL): string {
  if (!SUITE_NAME.test(suite)) throw new Error(`Invalid test suite name "${suite}": use lower-case letters and digits.`)
  const url = new URL(base)
  const name = decodeURIComponent(url.pathname.replace(/^\//, ''))
  if (name === '') throw new Error('DATABASE_URL_TEST must name a database.')
  url.pathname = `/${encodeURIComponent(`${name}_${suite}`)}`
  return url.toString()
}

/**
 * Create `suite`'s database if it is missing and bring it up to the current schema. `prisma migrate
 * deploy` creates a missing database itself, so nothing else has to exist beforehand. Returns the URL.
 */
export function prepareTestDatabase(suite: string): string {
  const url = testDatabaseUrl(suite)
  const dbPackage = resolve(dirname(fileURLToPath(import.meta.url)), '..')
  try {
    execSync('pnpm prisma migrate deploy', { cwd: dbPackage, env: { ...process.env, DATABASE_URL: url }, stdio: 'pipe' })
  } catch (e) {
    console.error(`Failed to run prisma migrate deploy on the "${suite}" test database:`, e)
    throw e
  }
  return url
}
