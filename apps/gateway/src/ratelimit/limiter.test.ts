import { randomUUID } from 'node:crypto'
import { Redis } from 'ioredis'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { RateLimiter } from './limiter.js'

const WINDOW = 60_000
const REDIS_URL = process.env['REDIS_URL_TEST'] ?? 'redis://localhost:6379/1'
const log = () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() })

describe('RateLimiter against Redis', () => {
  let redis: Redis
  let clock = 0
  const limiter = (windowMs = WINDOW) => new RateLimiter(redis, log(), { windowMs, breakerMs: 5_000, now: () => clock })
  const freshKey = () => `mcp:rl:test-${randomUUID()}`

  beforeAll(() => {
    redis = new Redis(REDIS_URL)
  })
  afterAll(() => {
    redis.disconnect()
  })

  it('allows up to the limit, then rejects with the time until a slot frees up', async () => {
    const rl = limiter()
    const key = freshKey()
    clock = 1_000_000

    for (let i = 1; i <= 3; i++) expect(await rl.check(key, 3)).toMatchObject({ allowed: true, limit: 3, remaining: 3 - i })

    expect(await rl.check(key, 3)).toEqual({ allowed: false, limit: 3, retryAfterSeconds: 60 })
    clock += 25_000
    expect(await rl.check(key, 3)).toEqual({ allowed: false, limit: 3, retryAfterSeconds: 35 })
  })

  it('resets once the window has passed', async () => {
    const rl = limiter()
    const key = freshKey()
    clock = 2_000_000
    for (let i = 0; i < 3; i++) await rl.check(key, 3)
    expect((await rl.check(key, 3)).allowed).toBe(false)

    clock += WINDOW
    expect(await rl.check(key, 3)).toMatchObject({ allowed: true, remaining: 2 })
  })

  it('slides: calls leave the window one by one, not all at once', async () => {
    const rl = limiter()
    const key = freshKey()
    clock = 3_000_000
    await rl.check(key, 3) // t+0
    clock += 20_000
    await rl.check(key, 3) // t+20
    clock += 20_000
    await rl.check(key, 3) // t+40
    expect((await rl.check(key, 3)).allowed).toBe(false)

    clock += 20_000 // t+60: only the first call has left the window
    expect(await rl.check(key, 3)).toMatchObject({ allowed: true, remaining: 0 })
    expect(await rl.check(key, 3)).toEqual({ allowed: false, limit: 3, retryAfterSeconds: 20 })
  })

  it('has no boundary burst: a full limit just before a boundary leaves nothing just after it', async () => {
    const rl = limiter()
    const key = freshKey()
    clock = 4_000_000 + 59_900
    for (let i = 0; i < 3; i++) expect((await rl.check(key, 3)).allowed).toBe(true)
    clock += 200 // 0.2 s later: "the next minute" for a fixed window
    expect((await rl.check(key, 3)).allowed).toBe(false)
  })

  it('does not record rejected calls, so hammering does not extend the lockout', async () => {
    const rl = limiter()
    const key = freshKey()
    clock = 5_000_000
    for (let i = 0; i < 2; i++) await rl.check(key, 2)
    for (let i = 0; i < 50; i++) expect((await rl.check(key, 2)).allowed).toBe(false)
    expect(await redis.zcard(key)).toBe(2)

    clock += WINDOW
    expect((await rl.check(key, 2)).allowed).toBe(true)
  })

  it('counts a batch by its cost, all or nothing', async () => {
    const rl = limiter()
    const key = freshKey()
    clock = 6_000_000
    expect(await rl.check(key, 5, 3)).toMatchObject({ allowed: true, remaining: 2 })
    expect((await rl.check(key, 5, 3)).allowed).toBe(false) // would be 6 of 5
    expect(await redis.zcard(key)).toBe(3) // nothing partial was added
    expect(await rl.check(key, 5, 2)).toMatchObject({ allowed: true, remaining: 0 })
  })

  it('waits for enough slots to free up when a batch needs several', async () => {
    const rl = limiter()
    const key = freshKey()
    clock = 7_000_000
    await rl.check(key, 4) // t+0
    clock += 10_000
    await rl.check(key, 4) // t+10
    clock += 10_000
    await rl.check(key, 4) // t+20
    await rl.check(key, 4) // t+20: 4 of 4
    // A batch of 3 needs three free slots: the calls at t+0, t+10 and the first at t+20 must leave,
    // which happens at t+80, i.e. 60 s from now.
    expect(await rl.check(key, 4, 3)).toEqual({ allowed: false, limit: 4, retryAfterSeconds: 60 })
  })

  it('never allows a batch larger than the limit, and says to wait a full window', async () => {
    const rl = limiter()
    clock = 8_000_000
    expect(await rl.check(freshKey(), 2, 3)).toEqual({ allowed: false, limit: 2, retryAfterSeconds: 60 })
  })

  it('keeps keys apart', async () => {
    const rl = limiter()
    const a = freshKey()
    const b = freshKey()
    clock = 9_000_000
    await rl.check(a, 1)
    expect((await rl.check(a, 1)).allowed).toBe(false)
    expect((await rl.check(b, 1)).allowed).toBe(true)
  })

  it('gives the key an expiry of one window, so idle keys disappear', async () => {
    const rl = limiter(5_000)
    const key = freshKey()
    clock = Date.now()
    await rl.check(key, 3)
    const ttl = await redis.pttl(key)
    expect(ttl).toBeGreaterThan(0)
    expect(ttl).toBeLessThanOrEqual(5_000)
  })

  it('lets exactly `limit` of many simultaneous calls through (one connection)', async () => {
    const rl = new RateLimiter(redis, log(), { windowMs: WINDOW, breakerMs: 5_000 }) // real clock
    const key = freshKey()
    const results = await Promise.all(Array.from({ length: 100 }, () => rl.check(key, 10)))
    expect(results.filter((r) => r.allowed)).toHaveLength(10)
    expect(await redis.zcard(key)).toBe(10)
  })

  it('lets exactly `limit` through when several gateway instances race on the same key', async () => {
    const connections = Array.from({ length: 4 }, () => new Redis(REDIS_URL))
    try {
      const limiters = connections.map((c) => new RateLimiter(c, log(), { windowMs: WINDOW, breakerMs: 5_000 }))
      const key = freshKey()
      const results = await Promise.all(Array.from({ length: 200 }, (_, i) => limiters[i % 4]!.check(key, 25)))
      expect(results.filter((r) => r.allowed)).toHaveLength(25)
      expect(await redis.zcard(key)).toBe(25)
    } finally {
      connections.forEach((c) => c.disconnect())
    }
  })

  it('reports the remaining count and the reset time on allowed calls', async () => {
    const rl = limiter()
    const key = freshKey()
    clock = 10_000_000
    await rl.check(key, 10)
    clock += 15_000
    expect(await rl.check(key, 10)).toEqual({ allowed: true, limit: 10, remaining: 8, resetSeconds: 45 })
  })
})

describe('RateLimiter when Redis fails (stubbed Redis)', () => {
  function stub() {
    const calls = { count: 0 }
    let mode: 'fail' | 'ok' = 'fail'
    const fake = {
      defineCommand(name: string) {
        ;(this as unknown as Record<string, unknown>)[name] = async () => {
          calls.count++
          if (mode === 'fail') throw new Error('connection refused')
          return [1, 1, 60_000]
        }
      },
    }
    return { fake: fake as unknown as Redis, calls, recover: () => (mode = 'ok') }
  }

  it('fails open and logs one warning', async () => {
    const { fake } = stub()
    const logger = log()
    const rl = new RateLimiter(fake, logger, { windowMs: WINDOW, breakerMs: 5_000, now: () => 1_000 })

    expect(await rl.check('k', 1)).toEqual({ allowed: true, degraded: true })
    expect(logger.warn).toHaveBeenCalledTimes(1)
  })

  it('stops asking Redis during the breaker window, without more warnings', async () => {
    const { fake, calls } = stub()
    const logger = log()
    let now = 1_000
    const rl = new RateLimiter(fake, logger, { windowMs: WINDOW, breakerMs: 5_000, now: () => now })

    await rl.check('k', 1)
    now += 4_999
    for (let i = 0; i < 20; i++) expect(await rl.check('k', 1)).toEqual({ allowed: true, degraded: true })

    expect(calls.count).toBe(1)
    expect(logger.warn).toHaveBeenCalledTimes(1)
  })

  it('tries Redis again after the breaker window, warns again if it is still down, and recovers when it is back', async () => {
    const { fake, calls, recover } = stub()
    const logger = log()
    let now = 1_000
    const rl = new RateLimiter(fake, logger, { windowMs: WINDOW, breakerMs: 5_000, now: () => now })

    await rl.check('k', 1)
    now += 5_000
    await rl.check('k', 1) // still down
    expect(calls.count).toBe(2)
    expect(logger.warn).toHaveBeenCalledTimes(2)

    recover()
    now += 5_000
    expect(await rl.check('k', 3)).toMatchObject({ allowed: true, limit: 3 })
    expect(await rl.check('k', 3)).not.toHaveProperty('degraded')
  })

  it('never throws', async () => {
    const { fake } = stub()
    const rl = new RateLimiter(fake, log(), { windowMs: WINDOW, breakerMs: 1 })
    await expect(rl.check('k', 1)).resolves.toBeDefined()
  })
})
