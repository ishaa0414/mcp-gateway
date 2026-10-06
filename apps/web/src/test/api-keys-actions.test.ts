/**
 * API key actions against the test database and Redis. The session is mocked; the action code,
 * validation and queries are real.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { hashApiKey } from '@mcp-gateway/crypto'
import { db } from '@mcp-gateway/db'
import { Redis } from 'ioredis'

const session = vi.hoisted(() => ({ userId: '' }))

vi.mock('@/auth', () => ({ auth: async () => (session.userId ? { user: { id: session.userId } } : null) }))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))

import { createApiKey, listApiKeys, revokeApiKey } from '@/actions/api-keys'

const redis = new Redis(process.env['REDIS_URL']!)
const users: string[] = []
let owner: { id: string; slug: string; projectId: string }
let intruder: { id: string; slug: string; projectId: string }

async function makeUserWithProject(label: string) {
  const user = await db.user.create({ data: { email: `${label}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@test.local`, name: label } })
  users.push(user.id)
  const slug = `keys-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
  const project = await db.project.create({ data: { userId: user.id, name: label, slug, upstreamBaseUrl: '' } })
  return { id: user.id, slug, projectId: project.id }
}

beforeAll(async () => {
  owner = await makeUserWithProject('owner')
  intruder = await makeUserWithProject('intruder')
  session.userId = owner.id
})

afterAll(async () => {
  await db.user.deleteMany({ where: { id: { in: users } } })
  redis.disconnect()
})

describe('createApiKey', () => {
  it('returns the full key once and stores only its hash', async () => {
    session.userId = owner.id

    const res = await createApiKey(owner.slug, { name: 'Production agent', rateLimitPerMin: 120 })

    expect(res.error).toBeUndefined()
    expect(res.key).toMatch(/^mcpg_[A-Za-z0-9_-]{32}$/)
    expect(res.apiKey).toMatchObject({ name: 'Production agent', rateLimitPerMin: 120, revokedAt: null, lastUsedAt: null })
    expect(res.apiKey!.prefix).toBe(`${res.key!.slice(0, 9)}…`)

    const row = await db.apiKey.findUniqueOrThrow({ where: { id: res.apiKey!.id } })
    expect(row.hash).toBe(hashApiKey(res.key!))
    expect(JSON.stringify(row)).not.toContain(res.key!)
    expect(row.projectId).toBe(owner.projectId)
  })

  it('accepts the rate limit as a numeric string, as a form sends it', async () => {
    const res = await createApiKey(owner.slug, { name: 'from a form', rateLimitPerMin: '90' })
    expect(res.apiKey?.rateLimitPerMin).toBe(90)
  })

  it.each([
    ['empty name', { name: '', rateLimitPerMin: 60 }, /name/i],
    ['blank name', { name: '   ', rateLimitPerMin: 60 }, /name/i],
    ['over-long name', { name: 'x'.repeat(61), rateLimitPerMin: 60 }, /60 characters/],
    ['zero rate limit', { name: 'k', rateLimitPerMin: 0 }, /At least 1/],
    ['huge rate limit', { name: 'k', rateLimitPerMin: 10_001 }, /At most 10,000/],
    ['fractional rate limit', { name: 'k', rateLimitPerMin: 1.5 }, /whole number/],
    ['non-numeric rate limit', { name: 'k', rateLimitPerMin: 'many' }, /number/i],
  ])('rejects %s', async (_label, input, expected) => {
    const before = await db.apiKey.count({ where: { projectId: owner.projectId } })

    const res = await createApiKey(owner.slug, input)

    expect(res.error).toMatch(expected)
    expect(res.key).toBeUndefined()
    expect(await db.apiKey.count({ where: { projectId: owner.projectId } })).toBe(before)
  })

  it('gives every key a different value', async () => {
    const a = await createApiKey(owner.slug, { name: 'a', rateLimitPerMin: 60 })
    const b = await createApiKey(owner.slug, { name: 'b', rateLimitPerMin: 60 })
    expect(a.key).not.toBe(b.key)
  })
})

describe('listApiKeys', () => {
  it('lists keys newest first, without the key or its hash', async () => {
    session.userId = owner.id
    const created = await createApiKey(owner.slug, { name: 'listed', rateLimitPerMin: 60 })

    const keys = await listApiKeys(owner.slug)

    expect(keys[0]!.id).toBe(created.apiKey!.id)
    const everything = JSON.stringify(keys)
    expect(everything).not.toContain(created.key!)
    expect(everything).not.toContain(hashApiKey(created.key!))
    for (const k of keys) expect(Object.keys(k).sort()).toEqual(['createdAt', 'id', 'lastUsedAt', 'name', 'prefix', 'rateLimitPerMin', 'revokedAt'])
  })
})

describe('revokeApiKey', () => {
  it('revokes, clears the gateway cache entry, and is idempotent', async () => {
    session.userId = owner.id
    const created = await createApiKey(owner.slug, { name: 'to revoke', rateLimitPerMin: 60 })
    const cacheKey = `mcp:key:${hashApiKey(created.key!)}`
    await redis.set(cacheKey, '{"cached":true}', 'EX', 60) // as if the gateway had cached it

    expect(await revokeApiKey(owner.slug, created.apiKey!.id)).toEqual({})

    const row = await db.apiKey.findUniqueOrThrow({ where: { id: created.apiKey!.id } })
    expect(row.revokedAt).toBeInstanceOf(Date)
    expect(await redis.exists(cacheKey)).toBe(0)

    const firstRevokedAt = row.revokedAt!.getTime()
    expect(await revokeApiKey(owner.slug, created.apiKey!.id)).toEqual({})
    expect((await db.apiKey.findUniqueOrThrow({ where: { id: created.apiKey!.id } })).revokedAt!.getTime()).toBe(firstRevokedAt)
  })

  it('shows up as revoked in the list', async () => {
    const created = await createApiKey(owner.slug, { name: 'listed revoked', rateLimitPerMin: 60 })
    await revokeApiKey(owner.slug, created.apiKey!.id)

    const found = (await listApiKeys(owner.slug)).find((k) => k.id === created.apiKey!.id)
    expect(found?.revokedAt).not.toBeNull()
  })
})

describe("one user cannot touch another user's keys", () => {
  it('cannot list, create or revoke through the other project', async () => {
    session.userId = owner.id
    const mine = await createApiKey(owner.slug, { name: 'mine', rateLimitPerMin: 60 })

    session.userId = intruder.id
    expect(await listApiKeys(owner.slug)).toEqual([])
    expect(await createApiKey(owner.slug, { name: 'planted', rateLimitPerMin: 60 })).toEqual({ error: 'Project not found' })
    expect(await revokeApiKey(owner.slug, mine.apiKey!.id)).toEqual({ error: 'Project not found' })

    expect((await db.apiKey.findUniqueOrThrow({ where: { id: mine.apiKey!.id } })).revokedAt).toBeNull()
    expect(await db.apiKey.count({ where: { projectId: owner.projectId, name: 'planted' } })).toBe(0)
  })

  it("cannot revoke the owner's key by using the intruder's own project", async () => {
    session.userId = owner.id
    const mine = await createApiKey(owner.slug, { name: 'mine 2', rateLimitPerMin: 60 })

    session.userId = intruder.id
    expect(await revokeApiKey(intruder.slug, mine.apiKey!.id)).toEqual({ error: 'Key not found' })

    expect((await db.apiKey.findUniqueOrThrow({ where: { id: mine.apiKey!.id } })).revokedAt).toBeNull()
  })

  it('does nothing when nobody is signed in', async () => {
    session.userId = ''
    expect(await listApiKeys(owner.slug)).toEqual([])
    expect(await createApiKey(owner.slug, { name: 'anon', rateLimitPerMin: 60 })).toEqual({ error: 'Project not found' })
    expect(await revokeApiKey(owner.slug, 'whatever')).toEqual({ error: 'Project not found' })
    session.userId = owner.id
  })
})
