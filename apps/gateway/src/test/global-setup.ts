import { prepareTestDatabase } from '@mcp-gateway/db/test-database'

export async function setup() {
  // The gateway suite's own database (mcpgateway_test_gateway). Its retention tests delete rows
  // table-wide, which is why no other package may share it.
  const testDbUrl = prepareTestDatabase('gateway')

  // Inherited by the test workers: the real database client reads these when first used.
  process.env['DATABASE_URL'] = testDbUrl
  // Many test workers share one Postgres (100 connections); keep each worker's pool small.
  process.env['DATABASE_POOL_MAX'] ??= '3'
  // Redis database 1, so tests never touch the cache the dev gateway uses (database 0).
  process.env['REDIS_URL_TEST'] ??= 'redis://localhost:6379/1'
}
