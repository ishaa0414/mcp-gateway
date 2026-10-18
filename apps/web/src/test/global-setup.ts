import { prepareTestDatabase } from '@mcp-gateway/db/test-database'

export async function setup() {
  // The web suite's own database (mcpgateway_test_web): no other package's tests can touch its rows.
  const testDbUrl = prepareTestDatabase('web')

  // Make the test DB URL available to worker threads via vitest's env injection
  process.env['DATABASE_URL'] = testDbUrl
  // Many test workers share one Postgres (100 connections); keep each worker's pool small.
  process.env['DATABASE_POOL_MAX'] ??= '3'
  // Redis database 1 (the dev gateway uses database 0), and a key for the credential tests.
  process.env['REDIS_URL_TEST'] ??= 'redis://localhost:6379/1'
  process.env['REDIS_URL'] = process.env['REDIS_URL_TEST']
  process.env['ENCRYPTION_KEY'] = 'cd'.repeat(32)
}
