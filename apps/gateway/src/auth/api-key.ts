import { hashApiKey } from '@mcp-gateway/crypto'
import type { PrismaClient } from '@mcp-gateway/db'
import { apiKeyCacheKey } from '@mcp-gateway/shared'
import type { SafeRedis } from '../cache/safe-redis.js'
import type { AppConfig } from '../config.js'

export interface AuthenticatedKey {
  id: string
  projectId: string
  /** The slug of the project the key belongs to. Immutable, so safe to cache. */
  slug: string
  rateLimitPerMin: number
}

interface Deps {
  db: PrismaClient
  cache: SafeRedis
  config: AppConfig
}

// Unknown and revoked keys are cached briefly too, so guessing keys cannot turn every
// attempt into a database query.
const NEGATIVE_TTL_SECONDS = 10

/** Resolve an API key to its project, or null when it is unknown or revoked. Only the SHA-256 hash is looked up. */
export async function lookupApiKey(token: string, { db, cache, config }: Deps): Promise<AuthenticatedKey | null> {
  const hash = hashApiKey(token)
  const cacheKey = apiKeyCacheKey(hash)

  const cached = await cache.getJson<AuthenticatedKey>(cacheKey)
  if (cached !== undefined) return cached

  const row = await db.apiKey.findUnique({
    where: { hash },
    select: { id: true, projectId: true, rateLimitPerMin: true, revokedAt: true, project: { select: { slug: true } } },
  })

  if (!row || row.revokedAt !== null) {
    await cache.setJson(cacheKey, null, NEGATIVE_TTL_SECONDS)
    return null
  }

  const key: AuthenticatedKey = {
    id: row.id,
    projectId: row.projectId,
    slug: row.project.slug,
    rateLimitPerMin: row.rateLimitPerMin,
  }
  await cache.setJson(cacheKey, key, config.apiKeyCacheTtlSeconds)
  return key
}
