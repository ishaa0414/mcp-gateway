import { prepareTestDatabase } from '@mcp-gateway/db/test-database'

export async function setup() {
  // The worker suite's own database (mcpgateway_test_worker): its retention test purges table-wide.
  const testDbUrl = prepareTestDatabase('worker')

  // Inherited by the test workers: the real database client reads these when first used.
  process.env['DATABASE_URL'] = testDbUrl
  process.env['DATABASE_POOL_MAX'] ??= '3'
  // Redis database 1, so tests never touch the queue the dev worker uses (database 0).
  process.env['REDIS_URL_TEST'] ??= 'redis://localhost:6379/1'
}
