import 'server-only'
import { Redis } from 'ioredis'
import { CacheInvalidator } from '@/lib/cache-invalidator'

// One client and one invalidator per process, kept on globalThis so dev hot reloads reuse them.
const g = globalThis as { __webRedis?: Redis; __webCacheInvalidator?: CacheInvalidator }

function client(): Redis {
  if (!g.__webRedis) {
    const url = process.env['REDIS_URL']
    if (!url) throw new Error('REDIS_URL is not set')
    // Lazy connection and short timeouts: the dashboard must never wait on Redis.
    g.__webRedis = new Redis(url, {
      lazyConnect: true,
      connectTimeout: 1_000,
      commandTimeout: 1_000,
      maxRetriesPerRequest: 1,
    })
    g.__webRedis.on('error', () => undefined) // surfaced by CacheInvalidator as a warning
  }
  return g.__webRedis
}

export const cacheInvalidator = (g.__webCacheInvalidator ??= new CacheInvalidator(client))
