import { randomUUID } from 'node:crypto'
import type { Redis } from 'ioredis'
import type { Logger } from '../config.js'

/**
 * Sliding-window log, one Redis sorted set per API key: a member per accepted call, scored
 * by its time. A call is allowed while fewer than `limit` members are newer than `now - window`,
 * so no 60-second span ever holds more than `limit` calls (a fixed window would allow twice that
 * across a boundary). Rejected calls are not recorded, so hammering does not extend the lockout.
 *
 * The whole check-and-add is one Lua script: Redis runs it without interleaving other commands,
 * so requests that arrive together cannot all pass the check before any of them is counted.
 * The clock comes from the gateway (a few milliseconds of skew between instances is irrelevant
 * against a 60-second window, and it keeps the script free of non-deterministic commands, which
 * not every hosted Redis allows).
 */
const SLIDING_WINDOW_LUA = `
local key = KEYS[1]
local limit = tonumber(ARGV[1])
local window = tonumber(ARGV[2])
local cost = tonumber(ARGV[3])
local now = tonumber(ARGV[4])
local id = ARGV[5]

redis.call('ZREMRANGEBYSCORE', key, '-inf', now - window)
local count = redis.call('ZCARD', key)

if count + cost > limit then
  -- Free again once enough of the oldest calls have left the window.
  local needed = count + cost - limit
  local retry = window
  if needed <= count then
    local entry = redis.call('ZRANGE', key, needed - 1, needed - 1, 'WITHSCORES')
    retry = tonumber(entry[2]) + window - now
  end
  return {0, count, retry}
end

for i = 1, cost do
  redis.call('ZADD', key, now, id .. ':' .. i)
end
redis.call('PEXPIRE', key, window)
local oldest = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
return {1, count + cost, tonumber(oldest[2]) + window - now}
`

export interface RateLimiterOptions {
  windowMs: number
  /** After a Redis failure, skip Redis (and allow calls) for this long instead of waiting on it again. */
  breakerMs: number
  now?: () => number
}

export type RateLimitDecision =
  | { allowed: true; limit: number; remaining: number; resetSeconds: number }
  | { allowed: false; limit: number; retryAfterSeconds: number }
  /** Redis could not be asked. The call is allowed (see {@link RateLimiter}). */
  | { allowed: true; degraded: true }

type SlidingWindowCommand = (key: string, limit: number, windowMs: number, cost: number, now: number, id: string) => Promise<[number, number, number]>

const seconds = (ms: number) => Math.max(1, Math.ceil(ms / 1000))

/**
 * Per-key rate limiter. If Redis fails it fails open: the gateway's rule is that Redis is a
 * cache, not a dependency, so an outage must not take every customer's agents down. The cost
 * is that nothing is limited while Redis is unreachable; the upstream API is protected only
 * by its own limits for that time. A short circuit breaker stops each call from waiting out
 * the Redis timeout, and a single warning is logged per outage window.
 */
export class RateLimiter {
  private readonly slidingWindow: SlidingWindowCommand
  private readonly now: () => number
  private breakerOpenUntil = 0

  constructor(
    redis: Redis,
    private readonly log: Logger,
    private readonly options: RateLimiterOptions
  ) {
    this.now = options.now ?? Date.now
    redis.defineCommand('mcpSlidingWindow', { numberOfKeys: 1, lua: SLIDING_WINDOW_LUA })
    this.slidingWindow = (redis as unknown as { mcpSlidingWindow: SlidingWindowCommand }).mcpSlidingWindow.bind(redis)
  }

  /** Count `cost` calls against the key, if the limit allows. Never throws. */
  async check(keyName: string, limit: number, cost = 1): Promise<RateLimitDecision> {
    const now = this.now()
    if (now < this.breakerOpenUntil) return { allowed: true, degraded: true }

    try {
      const [allowed, count, ms] = await this.slidingWindow(keyName, limit, this.options.windowMs, cost, now, randomUUID())
      return allowed === 1
        ? { allowed: true, limit, remaining: Math.max(0, limit - count), resetSeconds: seconds(ms) }
        : { allowed: false, limit, retryAfterSeconds: seconds(ms) }
    } catch (err) {
      this.breakerOpenUntil = now + this.options.breakerMs
      this.log.warn(
        { err: err instanceof Error ? err.message : String(err), breakerMs: this.options.breakerMs },
        'rate limiting unavailable: Redis failed, allowing calls unlimited until it recovers'
      )
      return { allowed: true, degraded: true }
    }
  }
}
