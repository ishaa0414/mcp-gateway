import { execSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export async function setup() {
  const testDbUrl =
    process.env['DATABASE_URL_TEST'] ?? 'postgresql://postgres:postgres@localhost:5432/mcpgateway_test'

  // Inherited by the test workers: the real database client reads these when first used.
  process.env['DATABASE_URL'] = testDbUrl
  process.env['DATABASE_URL_TEST'] = testDbUrl
  // Many test workers share one Postgres (100 connections); keep each worker's pool small.
  process.env['DATABASE_POOL_MAX'] ??= '3'
  // Redis database 1, so tests never touch the cache the dev gateway uses (database 0).
  process.env['REDIS_URL_TEST'] ??= 'redis://localhost:6379/1'

  const dbPackage = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../packages/db')
  try {
    execSync('pnpm prisma migrate deploy', {
      cwd: dbPackage,
      env: { ...process.env, DATABASE_URL: testDbUrl },
      stdio: 'pipe',
    })
  } catch (e) {
    console.error('Failed to run prisma migrate deploy on the test database:', e)
    throw e
  }
}
