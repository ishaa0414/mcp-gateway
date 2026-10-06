// Must be first: loads the root .env and validates it before any module that
// reads process.env at import time (e.g. @mcp-gateway/db).
import { env } from './env.js'

import { db } from '@mcp-gateway/db'
import { Redis } from 'ioredis'
import { buildApp } from './app.js'

// Fail fast on Redis problems: a cache miss is cheaper than a request that waits.
const redis = new Redis(env.REDIS_URL, {
  maxRetriesPerRequest: 1,
  connectTimeout: 2_000,
  commandTimeout: 1_000,
  enableOfflineQueue: false,
  lazyConnect: true,
})
redis.on('error', () => undefined) // reported by the cache wrapper and /health; do not crash on it

const app = await buildApp({
  db,
  redis,
  config: {
    encryptionKey: env.ENCRYPTION_KEY,
    toolTimeoutMs: env.TOOL_CALL_TIMEOUT_MS,
    toolMaxResponseBytes: env.TOOL_RESPONSE_MAX_BYTES,
    configCacheTtlSeconds: env.CONFIG_CACHE_TTL_SECONDS,
    apiKeyCacheTtlSeconds: env.API_KEY_CACHE_TTL_SECONDS,
    lastUsedIntervalMs: 5 * 60 * 1000,
  },
})

redis.connect().catch((err: unknown) => {
  app.log.warn({ err: err instanceof Error ? err.message : String(err) }, 'could not connect to Redis yet; serving from Postgres')
})

// Containers are stopped with SIGTERM: finish in-flight requests, then release connections.
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => {
    app.log.info({ signal }, 'shutting down')
    app
      .close()
      .then(async () => {
        redis.disconnect()
        await db.$disconnect()
        process.exit(0)
      })
      .catch((err: unknown) => {
        app.log.error(err, 'error during shutdown')
        process.exit(1)
      })
  })
}

try {
  await app.listen({ port: env.port, host: '0.0.0.0' })
} catch (err) {
  app.log.error(err)
  process.exit(1)
}
