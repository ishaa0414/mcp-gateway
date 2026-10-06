import { execSync } from 'node:child_process'
import { resolve } from 'node:path'

export async function setup() {
  const testDbUrl =
    process.env['DATABASE_URL_TEST'] ??
    'postgresql://postgres:postgres@localhost:5432/mcpgateway_test'

  // Make the test DB URL available to worker threads via vitest's env injection
  process.env['DATABASE_URL'] = testDbUrl
  process.env['DATABASE_URL_TEST'] = testDbUrl
  // Many test workers share one Postgres (100 connections); keep each worker's pool small.
  process.env['DATABASE_POOL_MAX'] ??= '3'

  const prismaSchemaDir = resolve(__dirname, '../../../../packages/db')

  try {
    execSync('pnpm prisma migrate deploy', {
      cwd: prismaSchemaDir,
      env: { ...process.env, DATABASE_URL: testDbUrl },
      stdio: 'pipe',
    })
  } catch (e) {
    console.error('Failed to run prisma migrate deploy on test DB:', e)
    throw e
  }
}
