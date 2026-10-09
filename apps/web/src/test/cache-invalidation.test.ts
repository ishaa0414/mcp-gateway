/**
 * Every dashboard action that changes what the gateway serves must clear that project's cached
 * configuration (or the API key entry). Redis here is the real test instance.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { hashApiKey } from '@mcp-gateway/crypto'
import { db } from '@mcp-gateway/db'
import { Redis } from 'ioredis'

const session = vi.hoisted(() => ({ userId: '' }))

vi.mock('@/auth', () => ({ auth: async () => (session.userId ? { user: { id: session.userId } } : null) }))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))
vi.mock('next/navigation', () => ({
  redirect: (url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`)
  },
}))

import { createApiKey, revokeApiKey } from '@/actions/api-keys'
import { updateCredential } from '@/actions/credentials'
import { deleteProject, updateProjectSettings } from '@/actions/projects'
import { importSpecFromFile } from '@/actions/spec'
import { updateTool, updateToolEnabled } from '@/actions/tools'

const redis = new Redis(process.env['REDIS_URL']!)
const cfgKey = (slug: string) => `mcp:cfg:${slug}`
const users: string[] = []

let slug: string
let projectId: string
let toolId: string

beforeAll(async () => {
  const tag = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
  const user = await db.user.create({ data: { email: `inval-${tag}@test.local`, name: 'inval' } })
  users.push(user.id)
  session.userId = user.id
  slug = `inval-${tag}`
  const project = await db.project.create({ data: { userId: user.id, name: 'Inval', slug, upstreamBaseUrl: '' } })
  projectId = project.id
  toolId = (
    await db.tool.create({
      data: {
        projectId,
        operationId: 'getPet',
        method: 'GET',
        path: '/pets/{id}',
        name: 'getPet',
        description: 'Get a pet',
        specName: 'getPet',
        specDescription: 'Get a pet',
        inputSchema: { type: 'object', properties: { id: { type: 'string' } } },
      },
    })
  ).id
})

afterAll(async () => {
  await db.user.deleteMany({ where: { id: { in: users } } })
  redis.disconnect()
})

/** Pretend the gateway has cached this project. */
beforeEach(async () => {
  await redis.set(cfgKey(slug), '{"cached":true}', 'EX', 300)
})

const cached = async () => (await redis.exists(cfgKey(slug))) === 1

describe('editing tools', () => {
  it('enabling or disabling a tool clears the project config', async () => {
    expect(await cached()).toBe(true)
    expect(await updateToolEnabled(toolId, false)).toEqual({})
    expect(await cached()).toBe(false)
  })

  it('renaming or re-describing a tool clears the project config', async () => {
    expect(await cached()).toBe(true)
    expect(await updateTool(toolId, { description: 'A different description' })).toEqual({})
    expect(await cached()).toBe(false)
  })

  it('a rejected edit changes nothing and does not clear the cache', async () => {
    expect((await updateTool(toolId, { name: 'not a valid name' })).error).toBeTruthy()
    expect(await cached()).toBe(true)
  })
})

describe('other changes that alter what the gateway serves', () => {
  it('importing a spec clears the project config', async () => {
    const spec = {
      openapi: '3.0.3',
      info: { title: 'T', version: '1' },
      paths: { '/x': { get: { operationId: 'getX', responses: { '200': { description: 'ok' } } } } },
    }
    const form = new FormData()
    form.set('spec', new File([JSON.stringify(spec)], 'spec.json', { type: 'application/json' }))

    const res = await importSpecFromFile(slug, form)

    expect(res).toMatchObject({ added: 1 })
    expect(await cached()).toBe(false)
  })

  it('changing project settings (name or base URL) clears the project config', async () => {
    expect((await updateProjectSettings(slug, { name: 'Renamed' })).error).toBeUndefined()
    expect(await cached()).toBe(false)
  })

  it('changing the upstream credential clears the project config', async () => {
    expect((await updateCredential(slug, { type: 'BEARER', value: 'a-new-secret-1' })).error).toBeUndefined()
    expect(await cached()).toBe(false)

    await redis.set(cfgKey(slug), '{"cached":true}', 'EX', 300)
    expect((await updateCredential(slug, { type: 'NONE' })).error).toBeUndefined()
    expect(await cached()).toBe(false)
  })

  it('a rejected settings change does not clear the cache', async () => {
    expect((await updateProjectSettings(slug, { upstreamBaseUrl: '/relative' })).error).toBeTruthy()
    expect(await cached()).toBe(true)
  })
})

describe('API keys', () => {
  it('revoking clears that key lookup entry, and only that one', async () => {
    const a = await createApiKey(slug, { name: 'a', rateLimitPerMin: 60 })
    const b = await createApiKey(slug, { name: 'b', rateLimitPerMin: 60 })
    const keyA = `mcp:key:${hashApiKey(a.key!)}`
    const keyB = `mcp:key:${hashApiKey(b.key!)}`
    await redis.set(keyA, '{"cached":true}', 'EX', 60)
    await redis.set(keyB, '{"cached":true}', 'EX', 60)

    await revokeApiKey(slug, a.apiKey!.id)

    expect(await redis.exists(keyA)).toBe(0)
    expect(await redis.exists(keyB)).toBe(1)
  })

  it('creating a key needs no invalidation and leaves the project config alone', async () => {
    await createApiKey(slug, { name: 'harmless', rateLimitPerMin: 60 })
    expect(await cached()).toBe(true)
  })
})

describe('deleting a project', () => {
  it('clears its project config and the lookups of all its keys', async () => {
    const tag = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
    const doomed = `doomed-${tag}`
    await db.project.create({ data: { userId: session.userId, name: 'Doomed', slug: doomed, upstreamBaseUrl: '' } })
    const k1 = await createApiKey(doomed, { name: 'k1', rateLimitPerMin: 60 })
    const k2 = await createApiKey(doomed, { name: 'k2', rateLimitPerMin: 60 })
    const keys = [`mcp:key:${hashApiKey(k1.key!)}`, `mcp:key:${hashApiKey(k2.key!)}`]
    await redis.set(cfgKey(doomed), '{"cached":true}', 'EX', 300)
    for (const k of keys) await redis.set(k, '{"cached":true}', 'EX', 60)

    await expect(deleteProject(doomed, doomed)).rejects.toThrow('NEXT_REDIRECT:/projects')

    expect(await redis.exists(cfgKey(doomed))).toBe(0)
    for (const k of keys) expect(await redis.exists(k)).toBe(0)
  })
})
