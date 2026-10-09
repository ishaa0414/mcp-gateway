import { invalidateApiKey, invalidateProjectConfig, type RedisLike } from '@mcp-gateway/shared'

type Warn = (message: string, context: Record<string, unknown>) => void

/**
 * Tells the gateway to forget cached data after a dashboard edit.
 *
 * It fails open: if Redis is unreachable the edit has already been saved to Postgres, so the
 * action must still succeed. The gateway's cache entries expire on their own (config 5 min,
 * API keys 30 s), which bounds how long a missed invalidation can matter. After a failure it
 * stops trying for a while, so a Redis outage costs one short delay, not one per edit.
 */
export class CacheInvalidator {
  private pausedUntil = 0

  constructor(
    private readonly getClient: () => RedisLike,
    private readonly warn: Warn = (message, context) => console.warn(message, context),
    private readonly now: () => number = Date.now,
    private readonly pauseMs = 30_000
  ) {}

  /** The project's tools, spec, credential or settings changed. */
  project(slug: string): Promise<void> {
    return this.run('project configuration', (redis) => invalidateProjectConfig(redis, slug))
  }

  /** An API key was revoked. */
  apiKey(hash: string): Promise<void> {
    return this.run('API key lookup', (redis) => invalidateApiKey(redis, hash))
  }

  private async run(what: string, action: (redis: RedisLike) => Promise<void>): Promise<void> {
    if (this.now() < this.pausedUntil) {
      this.warn(`[cache] Redis is unavailable; not invalidating ${what} (the TTL will expire it)`, {})
      return
    }
    try {
      await action(this.getClient())
    } catch (err) {
      this.pausedUntil = this.now() + this.pauseMs
      this.warn(`[cache] could not invalidate ${what}; relying on the TTL`, {
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }
}
