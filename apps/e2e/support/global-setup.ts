import { Redis } from 'ioredis'
import { FIXTURE_URL, REDIS_DB, assertSafeTargets } from './environment'

// The servers are up by now. Start from an empty Redis database 3 (cached configs and keys from an earlier run) and an
// empty request log on the fixture upstream.
export default async function globalSetup(): Promise<void> {
  const redisUrl = process.env['REDIS_URL']!
  assertSafeTargets(process.env['DATABASE_URL']!, redisUrl)

  const redis = new Redis(redisUrl, { lazyConnect: true, maxRetriesPerRequest: 1 })
  try {
    await redis.connect()
    if ((redis.options.db ?? 0) !== REDIS_DB) throw new Error(`e2e: refusing to flush Redis database ${redis.options.db}`)
    await redis.flushdb()
  } finally {
    redis.disconnect()
  }
  await fetch(`${FIXTURE_URL}/__reset`)
}
