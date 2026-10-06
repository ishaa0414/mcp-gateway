import { encrypt } from '@mcp-gateway/crypto'
import { db } from '@mcp-gateway/db'
import { apiKeyCacheKey, invalidateProjectConfig, projectConfigKey } from '@mcp-gateway/shared'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  cleanupFixtures,
  connectV2,
  createFixture,
  ENCRYPTION_KEY,
  json,
  rpc,
  startGateway,
  startUpstream,
  textOf,
  type MockUpstream,
  type RunningGateway,
} from './harness.js'

let gateway: RunningGateway
let upstream: MockUpstream

beforeAll(async () => {
  vi.stubEnv('NODE_ENV', 'development')
  vi.stubEnv('ALLOW_PRIVATE_UPSTREAMS', 'true')
  upstream = await startUpstream((req, res) => json(res, { url: req.url, authorization: req.headers['authorization'] ?? null, apiKey: req.headers['x-api-key'] ?? null }))
  gateway = await startGateway()
})

afterAll(async () => {
  await gateway.close()
  await upstream.close()
  await cleanupFixtures()
  vi.unstubAllEnvs()
})

const toolNames = async (slug: string, key: string, gw = gateway) =>
  ((await rpc(gw.mcpUrl(slug), key, 'tools/list')).body['result']['tools'] as Array<{ name: string }>).map((t) => t.name)

describe('project configuration cache', () => {
  it('is filled on first use, with a TTL', async () => {
    const fx = await createFixture({ upstreamBaseUrl: upstream.url })
    expect(await gateway.redis.exists(projectConfigKey(fx.slug))).toBe(0)

    await toolNames(fx.slug, fx.apiKey)

    expect(await gateway.redis.exists(projectConfigKey(fx.slug))).toBe(1)
    const ttl = await gateway.redis.ttl(projectConfigKey(fx.slug))
    expect(ttl).toBeGreaterThan(0)
    expect(ttl).toBeLessThanOrEqual(300)
  })

  it('holds only enabled tools, and the credential still encrypted', async () => {
    const fx = await createFixture({
      upstreamBaseUrl: upstream.url,
      disabled: ['deletePet'],
      credential: { type: 'BEARER', value: 'plaintext-secret-9981' },
    })
    await toolNames(fx.slug, fx.apiKey)

    const raw = (await gateway.redis.get(projectConfigKey(fx.slug)))!

    expect(raw).not.toContain('plaintext-secret-9981')
    expect(raw).not.toContain('deletePet')
    expect(JSON.parse(raw).credential.encryptedValue).toBeTruthy()
  })

  it('serves from the cache until it is invalidated, then reflects an edited tool', async () => {
    const fx = await createFixture({ upstreamBaseUrl: upstream.url })
    expect(await toolNames(fx.slug, fx.apiKey)).toContain('getPet')

    // Edit the tool the way the dashboard does: straight in the database.
    await db.tool.update({ where: { id: fx.toolIds['getPet']! }, data: { enabled: false } })
    await db.tool.update({ where: { id: fx.toolIds['listPets']! }, data: { name: 'list_all_pets' } })

    // Not invalidated yet: the cache is what is being served (this proves it is used).
    const stale = await toolNames(fx.slug, fx.apiKey)
    expect(stale).toContain('getPet')
    expect(stale).toContain('listPets')

    await invalidateProjectConfig(gateway.redis, fx.slug) // what the dashboard calls after an edit

    const fresh = await toolNames(fx.slug, fx.apiKey)
    expect(fresh).not.toContain('getPet')
    expect(fresh).not.toContain('listPets')
    expect(fresh).toContain('list_all_pets')
  })

  it('picks up a changed credential after invalidation', async () => {
    const fx = await createFixture({ upstreamBaseUrl: upstream.url, credential: { type: 'BEARER', value: 'old-token-1111' } })
    const client = await connectV2(gateway.mcpUrl(fx.slug), fx.apiKey)
    // What the upstream received (its echo in the response is masked, which is tested elsewhere).
    const sentAuthorization = async () => {
      await client.callTool({ name: 'getPet', arguments: { petId: 1 } })
      return upstream.requests[upstream.requests.length - 1]!.headers['authorization']
    }
    try {
      expect(await sentAuthorization()).toBe('Bearer old-token-1111')

      await db.upstreamCredential.update({
        where: { projectId: fx.projectId },
        data: { encryptedValue: encrypt('new-token-2222', ENCRYPTION_KEY) },
      })
      expect(await sentAuthorization()).toBe('Bearer old-token-1111')

      await invalidateProjectConfig(gateway.redis, fx.slug)
      expect(await sentAuthorization()).toBe('Bearer new-token-2222')
    } finally {
      await client.close()
    }
  })

  it('picks up a changed upstream base URL after invalidation', async () => {
    const second = await startUpstream((_req, res) => json(res, { from: 'second' }))
    try {
      const fx = await createFixture({ upstreamBaseUrl: upstream.url })
      const call = async () => textOf((await rpc(gateway.mcpUrl(fx.slug), fx.apiKey, 'tools/call', { name: 'getPet', arguments: { petId: 1 } })).body['result'])

      expect(await call()).toContain('"url"')

      await db.project.update({ where: { id: fx.projectId }, data: { upstreamBaseUrl: second.url } })
      await invalidateProjectConfig(gateway.redis, fx.slug)

      expect(JSON.parse(await call())).toEqual({ from: 'second' })
    } finally {
      await second.close()
    }
  })

  it('treats a corrupt cache entry as a miss and repairs it', async () => {
    const fx = await createFixture({ upstreamBaseUrl: upstream.url })
    await gateway.redis.set(projectConfigKey(fx.slug), '{definitely not json')

    expect(await toolNames(fx.slug, fx.apiKey)).toContain('getPet')

    expect(JSON.parse((await gateway.redis.get(projectConfigKey(fx.slug)))!).slug).toBe(fx.slug)
  })

  it('keeps projects apart: one project never sees another project config', async () => {
    const a = await createFixture({ upstreamBaseUrl: upstream.url, disabled: ['deletePet'] })
    const b = await createFixture({ upstreamBaseUrl: upstream.url })

    expect(await toolNames(a.slug, a.apiKey)).not.toContain('deletePet')
    expect(await toolNames(b.slug, b.apiKey)).toContain('deletePet')
  })
})

describe('API key lookup cache', () => {
  it('caches a valid key, and caches an unknown key briefly as a miss', async () => {
    const fx = await createFixture({ upstreamBaseUrl: upstream.url })
    await toolNames(fx.slug, fx.apiKey)
    expect(await gateway.redis.exists(apiKeyCacheKey(fx.apiKeyHash))).toBe(1)

    const bogus = 'mcpg_' + 'Z'.repeat(32)
    await rpc(gateway.mcpUrl(fx.slug), bogus, 'tools/list')
    const { hashApiKey } = await import('@mcp-gateway/crypto')
    const negative = apiKeyCacheKey(hashApiKey(bogus))
    expect(await gateway.redis.get(negative)).toBe('null')
    expect(await gateway.redis.ttl(negative)).toBeLessThanOrEqual(10)
  })
})

describe('Redis unavailable', () => {
  it('fails open: the gateway keeps serving from Postgres', async () => {
    const noRedis = await startGateway({ redisUrl: 'redis://127.0.0.1:1' })
    try {
      const fx = await createFixture({ upstreamBaseUrl: upstream.url, credential: { type: 'BEARER', value: 'still-works-5555' } })

      expect(await toolNames(fx.slug, fx.apiKey, noRedis)).toContain('getPet')
      await rpc(noRedis.mcpUrl(fx.slug), fx.apiKey, 'tools/call', { name: 'getPet', arguments: { petId: 4 } })
      expect(upstream.requests[upstream.requests.length - 1]!.headers['authorization']).toBe('Bearer still-works-5555')
    } finally {
      await noRedis.close()
    }
  })

  it('reports Redis as unhealthy but stays up', async () => {
    const noRedis = await startGateway({ redisUrl: 'redis://127.0.0.1:1' })
    try {
      const res = await fetch(`${noRedis.baseUrl}/health`)
      expect(res.status).toBe(503)
      expect(await res.json()).toMatchObject({ postgres: 'ok', redis: 'error' })
    } finally {
      await noRedis.close()
    }
  })
})
