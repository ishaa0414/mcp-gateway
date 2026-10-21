import { describe, expect, it } from 'vitest'
import { DEFAULT_TOOL_CALL_TIMEOUT_MS } from '@mcp-gateway/shared'
import { gatewayInternalUrl, parseWebEnv } from '@/lib/env'

const base = {
  AUTH_SECRET: 'a'.repeat(32),
  AUTH_URL: 'http://localhost:3000',
  DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
  REDIS_URL: 'redis://localhost:6379',
  ENCRYPTION_KEY: 'ab'.repeat(32),
}
const parse = (extra: Record<string, string> = {}) => parseWebEnv({ ...base, ...extra })

describe('web env: playground', () => {
  it('is off by default; the timeout default is the shared one', () => {
    const e = parse()
    expect(e.PLAYGROUND_SECRET).toBeUndefined()
    expect(e.GATEWAY_INTERNAL_URL).toBeUndefined()
    expect(e.TOOL_CALL_TIMEOUT_MS).toBe(DEFAULT_TOOL_CALL_TIMEOUT_MS)
  })

  it('treats an empty secret as unset and refuses one shorter than 32 bytes', () => {
    expect(parse({ PLAYGROUND_SECRET: '' }).PLAYGROUND_SECRET).toBeUndefined()
    expect(parse({ PLAYGROUND_SECRET: 'ab'.repeat(32) }).PLAYGROUND_SECRET).toBe('ab'.repeat(32))
    expect(() => parse({ PLAYGROUND_SECRET: 'short' })).toThrow(/PLAYGROUND_SECRET/)
  })

  it('wants an absolute internal URL', () => {
    expect(() => parse({ GATEWAY_INTERNAL_URL: 'gateway:4000' })).toThrow(/GATEWAY_INTERNAL_URL/)
  })

  it('calls the gateway on the internal URL, or else the public one, without a trailing slash', () => {
    expect(gatewayInternalUrl(parse())).toBe('http://localhost:4000')
    expect(gatewayInternalUrl(parse({ GATEWAY_PUBLIC_URL: 'https://gw.example.com/' }))).toBe('https://gw.example.com')
    expect(gatewayInternalUrl(parse({ GATEWAY_PUBLIC_URL: 'https://gw.example.com', GATEWAY_INTERNAL_URL: 'http://gateway.internal:4000' }))).toBe(
      'http://gateway.internal:4000'
    )
  })
})
