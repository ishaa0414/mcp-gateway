import { db } from '@mcp-gateway/db'
import { invalidateApiKey } from '@mcp-gateway/shared'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  addApiKey,
  cleanupFixtures,
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
let other: Fixture

beforeAll(async () => {
  vi.stubEnv('NODE_ENV', 'development')
  vi.stubEnv('ALLOW_PRIVATE_UPSTREAMS', 'true')
  upstream = await startUpstream((_req, res) => json(res, { ok: true }))
  gateway = await startGateway()
  fx = await createFixture({ upstreamBaseUrl: upstream.url })
  other = await createFixture({ upstreamBaseUrl: upstream.url })
})

afterAll(async () => {
  await gateway.close()
  await upstream.close()
  await cleanupFixtures()
  vi.unstubAllEnvs()
})

const list = (slug: string, key: string | undefined, headers?: Record<string, string>, gw = gateway) =>
  rpc(gw.mcpUrl(slug), key, 'tools/list', undefined, headers)

describe('API key authentication', () => {
  it('accepts a valid key for its own project', async () => {
    const res = await list(fx.slug, fx.apiKey)
    expect(res.status).toBe(200)
    expect(res.body['result']['tools'].length).toBeGreaterThan(0)
  })

  it('answers 401 with WWW-Authenticate and a JSON-RPC error when the key is missing', async () => {
    const res = await list(fx.slug, undefined)

    expect(res.status).toBe(401)
    expect(res.headers.get('www-authenticate')).toBe('Bearer realm="mcp-gateway"')
    expect(res.body).toMatchObject({ jsonrpc: '2.0', error: { code: -32001 }, id: null })
  })

  it('rejects malformed Authorization headers', async () => {
    for (const authorization of ['Basic dXNlcjpwYXNz', 'Bearer', 'Bearer not-a-key', fx.apiKey, `Token ${fx.apiKey}`]) {
      const res = await list(fx.slug, undefined, { authorization })
      expect(res.status, authorization).toBe(401)
    }
  })

  it('rejects a well-formed key that does not exist', async () => {
    const res = await list(fx.slug, 'mcpg_' + 'A'.repeat(32))
    expect(res.status).toBe(401)
  })

  it('rejects a revoked key', async () => {
    const revoked = await addApiKey(fx.projectId, true)
    const res = await list(fx.slug, revoked.key)
    expect(res.status).toBe(401)
  })

  it("rejects another project's key", async () => {
    const res = await list(fx.slug, other.apiKey)
    expect(res.status).toBe(401)
    // and the other project's own key still works on its own project
    expect((await list(other.slug, other.apiKey)).status).toBe(200)
  })

  it('answers an unknown project exactly like a bad key, so slugs cannot be enumerated', async () => {
    const wrongProject = await list('no-such-project', fx.apiKey)
    const badKey = await list(fx.slug, 'mcpg_' + 'B'.repeat(32))
    const missing = await list('no-such-project', undefined)

    expect(wrongProject.status).toBe(401)
    expect(wrongProject.body).toEqual(badKey.body)
    expect(missing.body).toEqual(badKey.body)
    expect(wrongProject.headers.get('www-authenticate')).toBe(badKey.headers.get('www-authenticate'))
  })

  it('never echoes the key back', async () => {
    const res = await rpc(gateway.mcpUrl(fx.slug), fx.apiKey, 'tools/list')
    expect(JSON.stringify(res.body)).not.toContain(fx.apiKey)
  })

  it('applies to tools/call too, and does not reach the upstream without a key', async () => {
    const res = await rpc(gateway.mcpUrl(fx.slug), undefined, 'tools/call', { name: 'getPet', arguments: { petId: 1 } })
    expect(res.status).toBe(401)
    expect(upstream.requests).toHaveLength(0)
  })

  it('stores only a hash: the plaintext key is nowhere in the database', async () => {
    const row = await db.apiKey.findUniqueOrThrow({ where: { id: fx.apiKeyId } })
    expect(JSON.stringify(row)).not.toContain(fx.apiKey)
    expect(row.hash).toMatch(/^[0-9a-f]{64}$/)
    expect(row.prefix.endsWith('…')).toBe(true)
  })
})

describe('revocation', () => {
  it('takes effect immediately once the cache entry is invalidated', async () => {
    const key = await addApiKey(fx.projectId)
    expect((await list(fx.slug, key.key)).status).toBe(200) // warms the cache

    await db.apiKey.update({ where: { id: key.id }, data: { revokedAt: new Date() } })
    await invalidateApiKey(gateway.redis, key.hash) // what the dashboard does

    expect((await list(fx.slug, key.key)).status).toBe(401)
  })

  it('is bounded by the cache TTL even if invalidation never arrives', async () => {
    const shortLived = await startGateway({ config: { apiKeyCacheTtlSeconds: 1 } })
    try {
      const key = await addApiKey(fx.projectId)
      expect((await list(fx.slug, key.key, undefined, shortLived)).status).toBe(200)

      await db.apiKey.update({ where: { id: key.id }, data: { revokedAt: new Date() } })
      // Still cached, so still accepted for the moment: this is the documented worst case.
      expect((await list(fx.slug, key.key, undefined, shortLived)).status).toBe(200)

      await new Promise((r) => setTimeout(r, 1300))
      expect((await list(fx.slug, key.key, undefined, shortLived)).status).toBe(401)
    } finally {
      await shortLived.close()
    }
  })

  it('also works without any cache (Redis down): the database decides', async () => {
    const noRedis = await startGateway({ redisUrl: 'redis://127.0.0.1:1' })
    try {
      const key = await addApiKey(fx.projectId)
      expect((await list(fx.slug, key.key, undefined, noRedis)).status).toBe(200)

      await db.apiKey.update({ where: { id: key.id }, data: { revokedAt: new Date() } })
      expect((await list(fx.slug, key.key, undefined, noRedis)).status).toBe(401)
    } finally {
      await noRedis.close()
    }
  })
})

describe('lastUsedAt', () => {
  const lastUsed = async (id: string) => (await db.apiKey.findUniqueOrThrow({ where: { id } })).lastUsedAt

  async function waitFor<T>(read: () => Promise<T | null>, ms = 3000): Promise<T> {
    const end = Date.now() + ms
    for (;;) {
      const value = await read()
      if (value !== null) return value
      if (Date.now() > end) throw new Error('timed out waiting')
      await new Promise((r) => setTimeout(r, 50))
    }
  }

  it('is set on first use, without slowing the request', async () => {
    const key = await addApiKey(fx.projectId)
    expect(await lastUsed(key.id)).toBeNull()

    expect((await list(fx.slug, key.key)).status).toBe(200)

    expect(await waitFor(() => lastUsed(key.id))).toBeInstanceOf(Date)
  })

  it('is written at most once per interval, not on every call', async () => {
    const key = await addApiKey(fx.projectId)
    const spy = vi.spyOn(db.apiKey, 'update')
    try {
      for (let i = 0; i < 5; i++) await list(fx.slug, key.key)
      await waitFor(() => lastUsed(key.id))

      const writes = spy.mock.calls.filter(([args]) => (args as { where: { id: string } }).where.id === key.id)
      expect(writes).toHaveLength(1)
    } finally {
      spy.mockRestore()
    }
  })

  it('is not written for a failed authentication', async () => {
    const key = await addApiKey(fx.projectId, true)
    await list(fx.slug, key.key)
    await new Promise((r) => setTimeout(r, 200))
    expect(await lastUsed(key.id)).toBeNull()
  })
})
