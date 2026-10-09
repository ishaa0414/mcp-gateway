/**
 * Redis key names the gateway and the dashboard must agree on, and the helpers the
 * dashboard calls to invalidate them. The dashboard and the gateway are separate
 * processes, so these names are the whole contract between them.
 */

/** Everything the gateway needs to serve a project: base URL, encrypted credential, enabled tools. */
export const projectConfigKey = (slug: string): string => `mcp:cfg:${slug}`

/** Result of looking up an API key by its SHA-256 hash. */
export const apiKeyCacheKey = (hash: string): string => `mcp:key:${hash}`

/** Sliding-window rate limit state of one API key (a sorted set of recent call times). */
export const rateLimitKey = (apiKeyId: string): string => `mcp:rl:${apiKeyId}`

/** The least a Redis client must offer for invalidation (ioredis satisfies this). */
export interface RedisLike {
  del(...keys: string[]): Promise<unknown>
}

/** Drop the cached configuration of a project (tools, spec, credential or settings changed). */
export async function invalidateProjectConfig(redis: RedisLike, slug: string): Promise<void> {
  await redis.del(projectConfigKey(slug))
}

/** Drop a cached API key lookup (the key was revoked). */
export async function invalidateApiKey(redis: RedisLike, hash: string): Promise<void> {
  await redis.del(apiKeyCacheKey(hash))
}
