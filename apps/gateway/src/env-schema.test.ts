import { describe, expect, it } from 'vitest'
import { gatewayEnvSchema } from './env-schema.js'

const base = {
  DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
  REDIS_URL: 'redis://localhost:6379',
  ENCRYPTION_KEY: 'ab'.repeat(32),
}

const parse = (extra: Record<string, string> = {}) => gatewayEnvSchema.safeParse({ ...base, ...extra })

describe('gateway env schema', () => {
  it('needs only the three required variables, and defaults the rest', () => {
    const result = parse()
    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.data).toMatchObject({
      port: 4000,
      TOOL_CALL_TIMEOUT_MS: 15_000,
      TOOL_RESPONSE_MAX_BYTES: 1024 * 1024,
      CONFIG_CACHE_TTL_SECONDS: 300,
      API_KEY_CACHE_TTL_SECONDS: 30,
      ALLOW_PRIVATE_UPSTREAMS: false,
    })
  })

  it('binds the port a hosting platform assigns through PORT', () => {
    const result = parse({ PORT: '10000' })
    expect(result.success && result.data.port).toBe(10000)
  })

  it('lets an explicit GATEWAY_PORT win over PORT', () => {
    const result = parse({ PORT: '10000', GATEWAY_PORT: '4100' })
    expect(result.success && result.data.port).toBe(4100)
  })

  it('refuses private upstreams in production, even if asked', () => {
    const result = parse({ NODE_ENV: 'production', ALLOW_PRIVATE_UPSTREAMS: 'true' })
    expect(result.success).toBe(false)
    expect(JSON.stringify(result.error?.issues)).toContain('must not be true in production')
  })

  it('allows private upstreams in development', () => {
    const result = parse({ NODE_ENV: 'development', ALLOW_PRIVATE_UPSTREAMS: 'true' })
    expect(result.success && result.data.ALLOW_PRIVATE_UPSTREAMS).toBe(true)
  })

  it.each([
    ['PORT', '0'],
    ['PORT', '70000'],
    ['ENCRYPTION_KEY', 'too-short'],
    ['TOOL_CALL_TIMEOUT_MS', '5'],
    ['TOOL_RESPONSE_MAX_BYTES', '999999999999'],
  ])('rejects %s=%s', (name, value) => {
    expect(parse({ [name]: value }).success).toBe(false)
  })
})
