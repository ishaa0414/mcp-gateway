/**
 * Renaming tools against the test database. The session is mocked; the action
 * code, validation and Prisma queries are real.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { db } from '@mcp-gateway/db'

const session = vi.hoisted(() => ({ userId: '' }))

vi.mock('@/auth', () => ({ auth: async () => ({ user: { id: session.userId } }) }))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))

import { updateTool } from '@/actions/tools'

const users: string[] = []
let projectId: string
const ids: Record<string, string> = {}

const makeTool = (name: string, extra: Record<string, unknown> = {}) =>
  db.tool.create({
    data: {
      projectId,
      operationId: `op_${name}`,
      method: 'GET',
      path: `/${name}`,
      name,
      description: 'd',
      specName: name,
      specDescription: 'd',
      inputSchema: { type: 'object', properties: {} },
      ...extra,
    },
  })

beforeAll(async () => {
  const user = await db.user.create({ data: { email: `tools-${Date.now()}@test.local`, name: 'Owner' } })
  session.userId = user.id
  users.push(user.id)
  const project = await db.project.create({
    data: { userId: user.id, name: 'Tools', slug: `tools-${Date.now()}`, upstreamBaseUrl: '' },
  })
  projectId = project.id

  for (const name of ['alpha', 'beta', 'gamma']) ids[name] = (await makeTool(name)).id
  ids['retired'] = (await makeTool('retired', { removedAt: new Date() })).id
})

afterAll(async () => {
  await db.user.deleteMany({ where: { id: { in: users } } })
})

const nameOf = async (key: string) => (await db.tool.findUniqueOrThrow({ where: { id: ids[key]! } })).name

describe('updateTool: name collisions', () => {
  it("rejects a name another tool in the project already uses, on the name field", async () => {
    const res = await updateTool(ids['beta']!, { name: 'alpha' })

    expect(res.field).toBe('name')
    expect(res.error).toContain('"alpha"')
    expect(res.error).toMatch(/must be unique/)
    expect(await nameOf('beta')).toBe('beta')
  })

  it('rejects the name of a removed tool too, because the database counts it', async () => {
    const res = await updateTool(ids['beta']!, { name: 'retired' })
    expect(res).toMatchObject({ field: 'name', error: expect.stringContaining('"retired"') })
  })

  it("accepts the tool's own name (e.g. when only the description changes)", async () => {
    const res = await updateTool(ids['gamma']!, { name: 'gamma', description: 'new words' })

    expect(res).toEqual({})
    expect(await db.tool.findUniqueOrThrow({ where: { id: ids['gamma']! } })).toMatchObject({
      name: 'gamma',
      description: 'new words',
    })
  })

  it('accepts a free name', async () => {
    expect(await updateTool(ids['beta']!, { name: 'beta_renamed' })).toEqual({})
    expect(await nameOf('beta')).toBe('beta_renamed')
    // …and the name it released is now available.
    expect(await updateTool(ids['gamma']!, { name: 'beta' })).toEqual({})
  })

  it('treats names as case-sensitive, matching the database index', async () => {
    expect(await updateTool(ids['gamma']!, { name: 'ALPHA' })).toEqual({})
  })

  it('still reports an invalid name on the name field', async () => {
    const res = await updateTool(ids['gamma']!, { name: 'find my pet' })
    expect(res).toMatchObject({ field: 'name', error: expect.stringContaining('spaces') })
  })

  it('turns a lost race into the same error instead of throwing', async () => {
    // Simulate another request taking the name between the check and the write:
    // the pre-check sees nothing, so only the unique index can stop it.
    const spy = vi.spyOn(db.tool, 'findFirst').mockResolvedValueOnce(null)
    try {
      const res = await updateTool(ids['gamma']!, { name: 'alpha' })
      expect(res).toMatchObject({ field: 'name', error: expect.stringContaining('"alpha"') })
    } finally {
      spy.mockRestore()
    }
    expect(await nameOf('alpha')).toBe('alpha')
  })

  it("will not touch another user's tool", async () => {
    const other = await db.user.create({ data: { email: `tools-other-${Date.now()}@test.local` } })
    users.push(other.id)
    const prev = session.userId
    session.userId = other.id
    try {
      expect(await updateTool(ids['alpha']!, { name: 'hijacked' })).toEqual({ error: 'Not found' })
    } finally {
      session.userId = prev
    }
    expect(await nameOf('alpha')).toBe('alpha')
  })
})
