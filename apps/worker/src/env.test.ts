import { afterEach, describe, expect, it, vi } from 'vitest'

afterEach(() => {
  vi.unstubAllEnvs()
  delete process.env['DATABASE_CONNECT_TIMEOUT_MS']
  vi.resetModules()
})

// The worker loads ./env.js before it uses the database, and the db package reads the variable when its client is first used.
describe('the worker connect timeout', () => {
  it('is 10 s when nothing sets it (the other apps use the db package default of 5 s)', async () => {
    vi.resetModules()
    delete process.env['DATABASE_CONNECT_TIMEOUT_MS']
    await import('./env.js')
    expect(process.env['DATABASE_CONNECT_TIMEOUT_MS']).toBe('10000')
  })

  it('is whatever the environment says when it is set', async () => {
    vi.resetModules()
    vi.stubEnv('DATABASE_CONNECT_TIMEOUT_MS', '2500')
    const { env } = await import('./env.js')
    expect(env.DATABASE_CONNECT_TIMEOUT_MS).toBe(2500)
  })
})
