import { describe, expect, it } from 'vitest'
import { DEFAULT_TOOL_CALL_TIMEOUT_MS, PLAYGROUND_GATEWAY_MARGIN_MS, playgroundRequestTimeoutMs } from './timeouts.js'

describe('timeouts', () => {
  it('the dashboard waits for the gateway timeout plus the margin', () => {
    expect(playgroundRequestTimeoutMs(DEFAULT_TOOL_CALL_TIMEOUT_MS)).toBe(DEFAULT_TOOL_CALL_TIMEOUT_MS + PLAYGROUND_GATEWAY_MARGIN_MS)
    expect(playgroundRequestTimeoutMs(1_000)).toBe(1_000 + PLAYGROUND_GATEWAY_MARGIN_MS)
  })

  it('the margin is positive, so the gateway always answers its own timeout before the dashboard gives up', () => {
    expect(PLAYGROUND_GATEWAY_MARGIN_MS).toBeGreaterThan(0)
  })
})
