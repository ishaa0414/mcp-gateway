import { describe, expect, it, vi } from 'vitest'
import { CacheInvalidator } from './cache-invalidator'

function setup(del: (...keys: string[]) => Promise<unknown>) {
  let clock = 1_000
  const warn = vi.fn()
  const getClient = vi.fn(() => ({ del }))
  const invalidator = new CacheInvalidator(getClient, warn, () => clock, 30_000)
  return { invalidator, warn, getClient, advance: (ms: number) => (clock += ms) }
}

describe('CacheInvalidator', () => {
  it('deletes the gateway cache keys', async () => {
    const del = vi.fn(async () => 1)
    const { invalidator, warn } = setup(del)

    await invalidator.project('petstore')
    await invalidator.apiKey('abc123')

    expect(del.mock.calls).toEqual([['mcp:cfg:petstore'], ['mcp:key:abc123']])
    expect(warn).not.toHaveBeenCalled()
  })

  it('swallows a Redis failure with a warning, so the dashboard action still succeeds', async () => {
    const { invalidator, warn } = setup(async () => {
      throw new Error('connect ECONNREFUSED')
    })

    await expect(invalidator.project('petstore')).resolves.toBeUndefined()

    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0]![0]).toContain('relying on the TTL')
    expect(warn.mock.calls[0]![1]).toEqual({ error: 'connect ECONNREFUSED' })
  })

  it('stops trying for a while after a failure, then tries again', async () => {
    const del = vi.fn<(...keys: string[]) => Promise<unknown>>().mockRejectedValueOnce(new Error('down'))
    const { invalidator, warn, advance } = setup(del)

    await invalidator.project('a') // fails, starts the pause
    await invalidator.project('b') // skipped: no call to Redis
    await invalidator.apiKey('c') // skipped too
    expect(del).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledTimes(3)

    advance(30_001)
    del.mockResolvedValue(1)
    await invalidator.project('d')

    expect(del).toHaveBeenCalledTimes(2)
    expect(del).toHaveBeenLastCalledWith('mcp:cfg:d')
  })

  it('does not log the API key hash it is invalidating', async () => {
    const { invalidator, warn } = setup(async () => {
      throw new Error('down')
    })

    await invalidator.apiKey('deadbeefcafebabe')

    expect(JSON.stringify(warn.mock.calls)).not.toContain('deadbeef')
  })

  it('survives the client factory itself failing (for example REDIS_URL unset)', async () => {
    const warn = vi.fn()
    const invalidator = new CacheInvalidator(
      () => {
        throw new Error('REDIS_URL is not set')
      },
      warn
    )

    await expect(invalidator.project('x')).resolves.toBeUndefined()
    expect(warn).toHaveBeenCalled()
  })
})
