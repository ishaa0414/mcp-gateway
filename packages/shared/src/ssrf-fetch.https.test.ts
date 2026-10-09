/**
 * HTTPS goes through a one-off undici Client (so SNI can name the real host while
 * the connection goes to the validated IP). Real TLS needs a trusted certificate,
 * so this checks the Client lifecycle with a mock instead.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ events: [] as string[], chunks: [] as Buffer[], connect: undefined as unknown }))

vi.mock('node:dns/promises', () => ({ lookup: vi.fn(async () => ({ address: '93.184.216.34', family: 4 })) }))
vi.mock('undici', () => ({
  request: vi.fn(),
  Client: class {
    constructor(_origin: string, opts: { connect?: unknown }) {
      state.connect = opts.connect
    }
    async request() {
      const chunks = state.chunks
      return {
        statusCode: 200,
        headers: { 'content-type': 'text/plain' },
        body: (async function* () {
          for (const c of chunks) {
            await new Promise((r) => setTimeout(r, 5))
            yield c
          }
          state.events.push('body-consumed')
        })(),
      }
    }
    async close() {
      state.events.push('closed')
    }
  },
}))

import { ssrfFetch } from './ssrf-fetch.js'

beforeEach(() => {
  state.events = []
  state.chunks = []
  state.connect = undefined
})

describe('https client lifecycle', () => {
  it('reads the whole body before closing the client (large responses must not stall)', async () => {
    state.chunks = Array.from({ length: 20 }, () => Buffer.alloc(32 * 1024, 'a')) // 640 KB

    const res = await ssrfFetch('https://api.example.com/big')

    expect(res.body.length).toBe(640 * 1024)
    expect(state.events).toEqual(['body-consumed', 'closed'])
  })

  it('closes the client when the response is rejected as too large', async () => {
    state.chunks = [Buffer.alloc(4096), Buffer.alloc(4096)]

    await expect(ssrfFetch('https://api.example.com/big', { maxBytes: 1024 })).rejects.toMatchObject({ code: 'TOO_LARGE' })
    expect(state.events).toContain('closed')
  })

  it('names the original host in the TLS handshake', async () => {
    state.chunks = [Buffer.from('ok')]
    await ssrfFetch('https://api.example.com/x')
    expect(state.connect).toEqual({ servername: 'api.example.com' })
  })
})
