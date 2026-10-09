import { describe, expect, it, vi } from 'vitest'
import { apiKeyCacheKey, invalidateApiKey, invalidateProjectConfig, projectConfigKey, rateLimitKey } from './cache-keys.js'

describe('cache keys', () => {
  it('are stable, because the dashboard and the gateway are separate processes', () => {
    expect(projectConfigKey('petstore')).toBe('mcp:cfg:petstore')
    expect(apiKeyCacheKey('abc123')).toBe('mcp:key:abc123')
    expect(rateLimitKey('key_1')).toBe('mcp:rl:key_1')
  })

  it('do not collide across kinds', () => {
    expect(new Set([projectConfigKey('x'), apiKeyCacheKey('x'), rateLimitKey('x')]).size).toBe(3)
  })
})

describe('invalidation helpers', () => {
  it('delete exactly the right key', async () => {
    const del = vi.fn(async () => 1)

    await invalidateProjectConfig({ del }, 'petstore')
    await invalidateApiKey({ del }, 'deadbeef')

    expect(del.mock.calls).toEqual([['mcp:cfg:petstore'], ['mcp:key:deadbeef']])
  })

  it('let a Redis failure propagate so the caller can decide (the dashboard fails open)', async () => {
    const del = vi.fn(async () => {
      throw new Error('redis down')
    })
    await expect(invalidateProjectConfig({ del }, 's')).rejects.toThrow('redis down')
  })
})
