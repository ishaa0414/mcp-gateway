import { prepareTestDatabase } from '@mcp-gateway/db/test-database'

export async function setup() {
  // The gateway suite's main database (mcpgateway_test_gateway), and a second one for the two files that run
  // retention (mcpgateway_test_gatewayretention): a purge deletes every old row in its table, whoever wrote
  // it, so it must not run where other files keep rows. See retention-database.ts.
  const mainUrl = prepareTestDatabase('gateway')
  const retentionUrl = prepareTestDatabase('gatewayretention')

  // Inherited by the test workers: the real database client reads these when first used.
  process.env['DATABASE_URL'] = mainUrl
  process.env['GATEWAY_MAIN_DATABASE_URL'] = mainUrl
  process.env['GATEWAY_RETENTION_DATABASE_URL'] = retentionUrl
  // Many test workers share one Postgres (100 connections); keep each worker's pool small.
  process.env['DATABASE_POOL_MAX'] ??= '3'
  // Redis database 1, so tests never touch the cache the dev gateway uses (database 0).
  process.env['REDIS_URL_TEST'] ??= 'redis://localhost:6379/1'
}
