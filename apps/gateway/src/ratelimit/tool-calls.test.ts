import { describe, expect, it } from 'vitest'
import { toolCallsIn } from './tool-calls.js'

const msg = (method: string, id?: number | string) => ({ jsonrpc: '2.0', method, ...(id !== undefined ? { id } : {}) })

describe('toolCallsIn', () => {
  it('counts a tools/call and returns its id', () => {
    expect(toolCallsIn(msg('tools/call', 7))).toEqual({ count: 1, firstId: 7 })
  })

  it.each(['initialize', 'notifications/initialized', 'tools/list', 'ping', 'resources/list'])('does not count %s', (method) => {
    expect(toolCallsIn(msg(method, 1)).count).toBe(0)
  })

  it('counts every tools/call in a batch and ignores the rest', () => {
    const batch = [msg('tools/list', 1), msg('tools/call', 'a'), msg('tools/call', 'b'), msg('ping', 4)]
    expect(toolCallsIn(batch)).toEqual({ count: 2, firstId: 'a' })
  })

  it('uses a null id for a call without one', () => {
    expect(toolCallsIn(msg('tools/call'))).toEqual({ count: 1, firstId: null })
  })

  it.each([undefined, null, 'tools/call', 42, [], [null, 'x'], { method: ['tools/call'] }])('counts nothing in %j', (body) => {
    expect(toolCallsIn(body).count).toBe(0)
  })
})
