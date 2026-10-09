import type { Redis } from 'ioredis'
import type { Logger } from '../config.js'

/**
 * Redis as a cache, never as a dependency: every failure becomes a miss and a warning, so a
 * Redis outage makes the gateway slower (it reads Postgres) instead of down.
 */
export class SafeRedis {
  constructor(
    private readonly redis: Redis,
    private readonly log: Logger
  ) {}

  /** The stored value; `undefined` when absent or when Redis failed. A stored JSON `null` comes back as `null`. */
  async getJson<T>(key: string): Promise<T | null | undefined> {
    try {
      const raw = await this.redis.get(key)
      return raw === null ? undefined : (JSON.parse(raw) as T | null)
    } catch (err) {
      this.warn('get', key, err)
      return undefined
    }
  }

  async setJson(key: string, value: unknown, ttlSeconds: number): Promise<void> {
    try {
      await this.redis.set(key, JSON.stringify(value), 'EX', ttlSeconds)
    } catch (err) {
      this.warn('set', key, err)
    }
  }

  private warn(op: string, key: string, err: unknown): void {
    this.log.warn({ op, key, err: err instanceof Error ? err.message : String(err) }, 'redis unavailable, falling back to Postgres')
  }
}
