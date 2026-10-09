import { describe, expect, it, vi } from 'vitest'
import { runStartup } from './startup.js'

describe('runStartup', () => {
  it('does not exit when startup succeeds', async () => {
    const exit = vi.fn()
    const log = vi.fn()
    await runStartup({ start: async () => undefined, timeoutMs: 1_000, log, exit })
    expect(exit).not.toHaveBeenCalled()
    expect(log).not.toHaveBeenCalled()
  })

  it('logs the error and exits 1 when startup throws', async () => {
    const exit = vi.fn()
    const log = vi.fn()
    await runStartup({
      start: async () => {
        throw new Error('Invalid environment: DATABASE_URL is required')
      },
      timeoutMs: 1_000,
      log,
      exit,
    })
    expect(exit).toHaveBeenCalledWith(1)
    expect(log.mock.calls[0]?.[0]).toContain('Invalid environment: DATABASE_URL is required')
  })

  it('logs a clear message and exits 1 when startup hangs past the timeout', async () => {
    vi.useFakeTimers()
    try {
      const exit = vi.fn()
      const log = vi.fn()
      const pending = runStartup({ start: () => new Promise(() => undefined), timeoutMs: 5_000, log, exit })
      await vi.advanceTimersByTimeAsync(5_000)
      expect(exit).toHaveBeenCalledWith(1)
      expect(log.mock.calls[0]?.[0]).toContain('did not start listening within 5s')
      void pending
    } finally {
      vi.useRealTimers()
    }
  })
})
