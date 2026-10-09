import { rateLimitKey } from '@mcp-gateway/shared'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  addApiKey,
  cleanupFixtures,
  connectV1,
  connectV2,
  createFixture,
  json,
  rpc,
  startGateway,
  startUpstream,
  type Fixture,
  type MockUpstream,
  type RunningGateway,
} from './harness.js'

let gateway: RunningGateway
let upstream: MockUpstream
let fx: Fixture

beforeAll(async () => {
  vi.stubEnv('NODE_ENV', 'development')
  vi.stubEnv('ALLOW_PRIVATE_UPSTREAMS', 'true')
  upstream = await startUpstream((_req, res) => json(res, { pets: [] }))
  gateway = await startGateway()
  fx = await createFixture({ upstreamBaseUrl: upstream.url })
})

afterAll(async () => {
  await gateway.close()
  await upstream.close()
  await cleanupFixtures()
  vi.unstubAllEnvs()
})

/** A key of this project with its own limit, so tests never share a counter. */
const keyWithLimit = async (limit: number) => (await addApiKey(fx.projectId, false, limit)).key

const callTool = (key: string, gw = gateway, slug = fx.slug) =>
  rpc(gw.mcpUrl(slug), key, 'tools/call', { name: 'listPets', arguments: {} })

const upstreamHits = () => upstream.requests.length

describe('limit enforcement', () => {
  it('lets a key make its stored limit of tool calls, then answers 429', async () => {
    const key = await keyWithLimit(3)
    const before = upstreamHits()

    for (let i = 0; i < 3; i++) expect((await callTool(key)).status).toBe(200)
    const blocked = await callTool(key)

    expect(blocked.status).toBe(429)
    expect(upstreamHits() - before).toBe(3) // the rejected call never reached the upstream
  })

  it('uses the limit stored on each key', async () => {
    const small = await keyWithLimit(1)
    const large = await keyWithLimit(5)

    expect((await callTool(small)).status).toBe(200)
    expect((await callTool(small)).status).toBe(429)
    for (let i = 0; i < 5; i++) expect((await callTool(large)).status).toBe(200)
    expect((await callTool(large)).status).toBe(429)
  })

  it('counts each key on its own', async () => {
    const a = await keyWithLimit(1)
    const b = await keyWithLimit(1)

    await callTool(a)
    expect((await callTool(a)).status).toBe(429)
    expect((await callTool(b)).status).toBe(200)
  })

  it('only counts tools/call: listing, initialising and pinging are free', async () => {
    const key = await keyWithLimit(2)
    const url = gateway.mcpUrl(fx.slug)

    for (let i = 0; i < 6; i++) {
      expect((await rpc(url, key, 'tools/list')).status).toBe(200)
      expect((await rpc(url, key, 'initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '1' } })).status).toBe(200)
    }
    expect((await callTool(key)).status).toBe(200)
    expect((await callTool(key)).status).toBe(200)
    expect((await callTool(key)).status).toBe(429)
    // Even at the limit, listing still works.
    expect((await rpc(url, key, 'tools/list')).status).toBe(200)
  })

  it('counts a batch once per tools/call inside it, and rejects it whole when it does not fit', async () => {
    const key = await keyWithLimit(3)
    const call = (id: number) => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'listPets', arguments: {} } })
    const post = (body: unknown) =>
      fetch(gateway.mcpUrl(fx.slug), {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${key}` },
        body: JSON.stringify(body),
      })
    const before = upstreamHits()

    const tooBig = await post([call(1), call(2), call(3), call(4)])
    expect(tooBig.status).toBe(429)
    expect(((await tooBig.json()) as { id: unknown }).id).toBe(1)
    expect(upstreamHits()).toBe(before)

    const fits = await post([call(1), { jsonrpc: '2.0', id: 2, method: 'tools/list' }, call(3)])
    expect(fits.status).not.toBe(429)
    expect(fits.headers.get('ratelimit-remaining')).toBe('1') // two of three used
  })

  it('is exact when many requests arrive at once', async () => {
    const key = await keyWithLimit(10)
    const before = upstreamHits()

    const responses = await Promise.all(Array.from({ length: 40 }, () => callTool(key)))
    const statuses = responses.map((r) => r.status)

    expect(statuses.filter((s) => s === 200)).toHaveLength(10)
    expect(statuses.filter((s) => s === 429)).toHaveLength(30)
    expect(upstreamHits() - before).toBe(10)
  })

  it('does not record rejected calls', async () => {
    const created = await addApiKey(fx.projectId, false, 2)
    const key = created.key

    for (let i = 0; i < 2; i++) await callTool(key)
    for (let i = 0; i < 10; i++) expect((await callTool(key)).status).toBe(429)

    const members = await gateway.redis.zcard(rateLimitKey(created.id))
    expect(members).toBe(2)
  })
})

describe('the window resets', () => {
  it('allows calls again once the window has passed (short window)', async () => {
    const short = await startGateway({ config: { rateLimitWindowMs: 1_500 } })
    try {
      const key = await keyWithLimit(2)
      expect((await callTool(key, short)).status).toBe(200)
      expect((await callTool(key, short)).status).toBe(200)
      const blocked = await callTool(key, short)
      expect(blocked.status).toBe(429)
      expect(blocked.headers.get('retry-after')).toBe('2') // 1.5 s rounded up

      await new Promise((r) => setTimeout(r, 1_700))
      expect((await callTool(key, short)).status).toBe(200)
    } finally {
      await short.close()
    }
  })
})

describe('the 429 response', () => {
  it('is HTTP 429 with a JSON-RPC error, the request id, Retry-After and RateLimit headers', async () => {
    const key = await keyWithLimit(2)
    await callTool(key)
    await callTool(key)

    const res = await rpc(gateway.mcpUrl(fx.slug), key, 'tools/call', { name: 'listPets', arguments: {} })

    expect(res.status).toBe(429)
    const retryAfter = Number(res.headers.get('retry-after'))
    expect(Number.isInteger(retryAfter)).toBe(true)
    expect(retryAfter).toBeGreaterThanOrEqual(1)
    expect(retryAfter).toBeLessThanOrEqual(60)
    expect(res.headers.get('ratelimit-limit')).toBe('2')
    expect(res.headers.get('ratelimit-remaining')).toBe('0')
    expect(res.headers.get('ratelimit-reset')).toBe(String(retryAfter))

    expect(res.body).toEqual({
      jsonrpc: '2.0',
      id: 1,
      error: {
        code: -32029,
        message: `Rate limit exceeded: 2 tool calls per minute for this API key. Retry in ${retryAfter} second${retryAfter === 1 ? '' : 's'}.`,
        data: { limit: 2, windowSeconds: 60, retryAfterSeconds: retryAfter },
      },
    })
  })

  it('tells allowed callers how much is left', async () => {
    const key = await keyWithLimit(5)
    const first = await callTool(key)
    const second = await callTool(key)

    expect(first.headers.get('ratelimit-limit')).toBe('5')
    expect(first.headers.get('ratelimit-remaining')).toBe('4')
    expect(second.headers.get('ratelimit-remaining')).toBe('3')
    expect(first.headers.get('retry-after')).toBeNull()
  })

  it('is exposed to browser clients through CORS', async () => {
    const res = await fetch(gateway.mcpUrl(fx.slug), { method: 'OPTIONS', headers: { origin: 'http://localhost:6274', 'access-control-request-method': 'POST' } })
    expect(res.status).toBeLessThan(300)
    const key = await keyWithLimit(1)
    await callTool(key)
    const blocked = await fetch(gateway.mcpUrl(fx.slug), {
      method: 'POST',
      headers: { origin: 'http://localhost:6274', 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${key}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'listPets', arguments: {} } }),
    })
    expect(blocked.status).toBe(429)
    const exposed = blocked.headers.get('access-control-expose-headers') ?? ''
    expect(exposed).toMatch(/retry-after/i)
    expect(exposed).toMatch(/ratelimit-remaining/i)
  })

  it('reaches MCP clients as an error that names the limit and the wait (SDK v2 client)', async () => {
    const key = await keyWithLimit(1)
    const client = await connectV2(gateway.mcpUrl(fx.slug), key)
    try {
      await client.callTool({ name: 'listPets', arguments: {} })
      const failure = await client.callTool({ name: 'listPets', arguments: {} }).then(
        () => null,
        (e: unknown) => e as Error
      )
      expect(failure).not.toBeNull()
      // The client prints the response body, not the status line, so the message itself must carry the news.
      expect(failure!.message).toMatch(/Rate limit exceeded: 1 tool calls per minute for this API key/)
      expect(failure!.message).toMatch(/Retry in \d+ seconds?/)
    } finally {
      await client.close()
    }
  })

  it('reaches MCP clients as an error that names the limit and the wait (SDK v1 client)', async () => {
    const key = await keyWithLimit(1)
    const client = await connectV1(gateway.mcpUrl(fx.slug), key)
    try {
      await client.callTool({ name: 'listPets', arguments: {} })
      const failure = await client.callTool({ name: 'listPets', arguments: {} }).then(
        () => null,
        (e: unknown) => e as Error
      )
      expect(failure).not.toBeNull()
      expect(failure!.message).toMatch(/Rate limit exceeded: 1 tool calls per minute for this API key/)
      expect(failure!.message).toMatch(/Retry in \d+ seconds?/)
    } finally {
      await client.close()
    }
  })
})

describe('order of checks', () => {
  it('answers 401 for a bad or missing key, even when asked to do more than allowed', async () => {
    const key = await keyWithLimit(1)
    await callTool(key)
    expect((await callTool(key)).status).toBe(429)

    expect((await callTool('mcpg_not-a-real-key-at-all')).status).toBe(401)
    expect((await rpc(gateway.mcpUrl(fx.slug), undefined, 'tools/call', { name: 'listPets', arguments: {} })).status).toBe(401)
  })

  it('does not let a key past the limit by naming another project, and counts nothing for rejected auth', async () => {
    const other = await createFixture({ upstreamBaseUrl: upstream.url })
    const key = await keyWithLimit(1)

    expect((await callTool(key, gateway, other.slug)).status).toBe(401) // wrong project: no call counted
    expect((await callTool(key)).status).toBe(200) // the one allowed call is still available
    expect((await callTool(key)).status).toBe(429)
  })

  it('does not limit the first (unauthenticated) request in a way that leaks anything: same 401 whether or not the slug exists', async () => {
    const a = await callTool('mcpg_nope-nope-nope', gateway, fx.slug)
    const b = await callTool('mcpg_nope-nope-nope', gateway, 'no-such-project-slug')
    expect(a.status).toBe(401)
    expect(b.status).toBe(401)
    expect(a.body).toEqual(b.body)
  })
})

describe('Redis unavailable', () => {
  it('fails open: calls go through and nothing is limited', async () => {
    const noRedis = await startGateway({ redisUrl: 'redis://127.0.0.1:1' })
    try {
      const key = await keyWithLimit(1)
      const before = upstreamHits()

      const started = performance.now()
      const statuses = []
      for (let i = 0; i < 8; i++) statuses.push((await callTool(key, noRedis)).status)

      expect(statuses).toEqual(Array(8).fill(200))
      expect(upstreamHits() - before).toBe(8)
      // The breaker keeps a dead Redis from adding its timeout to every call.
      expect(performance.now() - started).toBeLessThan(4_000)
    } finally {
      await noRedis.close()
    }
  })
})
