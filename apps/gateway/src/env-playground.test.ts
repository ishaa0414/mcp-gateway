import { describe, expect, it } from 'vitest'
import { gatewayEnvSchema } from './env-schema.js'

const base = {
  DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
  REDIS_URL: 'redis://localhost:6379',
  ENCRYPTION_KEY: 'ab'.repeat(32),
}
const parse = (extra: Record<string, string> = {}) => gatewayEnvSchema.safeParse({ ...base, ...extra })

describe('gateway env: playground', () => {
  it('is off by default, with 30 calls per minute per project', () => {
    const result = parse()
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.PLAYGROUND_SECRET).toBeUndefined()
      expect(result.data.PLAYGROUND_RATE_PER_MIN).toBe(30)
    }
  })

  it('treats an empty secret as unset (hosts often pass empty variables)', () => {
    const result = parse({ PLAYGROUND_SECRET: '' })
    expect(result.success).toBe(true)
    if (result.success) expect(result.data.PLAYGROUND_SECRET).toBeUndefined()
  })

  it('needs at least 32 bytes', () => {
    expect(parse({ PLAYGROUND_SECRET: 'x'.repeat(31) }).success).toBe(false)
    expect(parse({ PLAYGROUND_SECRET: 'x'.repeat(32) }).success).toBe(true)
    expect(parse({ PLAYGROUND_SECRET: 'ab'.repeat(32) }).success).toBe(true) // openssl rand -hex 32
  })

  it('takes a limit between 1 and 1000', () => {
    const limit = (v: string) => parse({ PLAYGROUND_RATE_PER_MIN: v })
    expect(limit('5').success).toBe(true)
    expect(limit('0').success).toBe(false)
    expect(limit('1001').success).toBe(false)
  })
})
