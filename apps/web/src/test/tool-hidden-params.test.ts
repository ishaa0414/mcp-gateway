/**
 * Saving hidden parameters through updateTool, against the test database. The session and the cache
 * invalidator are stubbed; the validation and Prisma writes are real.
 */
import { toAgentSchema } from '@mcp-gateway/openapi-tools'
import { db } from '@mcp-gateway/db'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const session = vi.hoisted(() => ({ userId: '' }))
const invalidateProject = vi.hoisted(() => vi.fn(async () => undefined))

vi.mock('@/auth', () => ({ auth: async () => ({ user: { id: session.userId } }) }))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))
vi.mock('@/lib/redis', () => ({ cacheInvalidator: { project: invalidateProject } }))

import { updateTool } from '@/actions/tools'

const schema = {
  type: 'object',
  required: ['petId'],
  properties: {
    petId: { type: 'integer', minimum: 1 },
    region: { type: 'string' },
    status: { type: 'string', enum: ['available', 'sold'] },
    photoUrls: { type: 'array', items: { type: 'string' } },
    verbose: { type: 'boolean' },
  },
}

const users: string[] = []
let slug: string
let toolId: string
let otherToolId: string

const stored = async () => (await db.tool.findUniqueOrThrow({ where: { id: toolId } })).hiddenParams

beforeAll(async () => {
  const owner = await db.user.create({ data: { email: `hidden-owner-${Date.now()}@test.local`, name: 'Owner' } })
  const other = await db.user.create({ data: { email: `hidden-other-${Date.now()}@test.local`, name: 'Other' } })
  users.push(owner.id, other.id)
  session.userId = owner.id

  const make = async (userId: string, label: string) => {
    const project = await db.project.create({
      data: { userId, name: label, slug: `hid-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, upstreamBaseUrl: 'https://api.example.com' },
    })
    const tool = await db.tool.create({
      data: {
        projectId: project.id, operationId: 'op_getPet', method: 'GET', path: '/pets/{petId}', name: 'getPet', description: 'd', specName: 'getPet',
        specDescription: 'd', inputSchema: schema,
      },
    })
    return { project, tool }
  }
  const mine = await make(owner.id, 'mine')
  slug = mine.project.slug
  toolId = mine.tool.id
  otherToolId = (await make(other.id, 'theirs')).tool.id
})

afterAll(async () => {
  await db.user.deleteMany({ where: { id: { in: users } } })
})

beforeEach(async () => {
  invalidateProject.mockClear()
  await db.tool.update({ where: { id: toolId }, data: { hiddenParams: {} } })
})

describe('updateTool: hiding a parameter', () => {
  it('stores { value, required } for each hidden parameter, with required taken from the schema', async () => {
    const res = await updateTool(toolId, {
      hiddenParams: { petId: { value: 7, required: false }, region: { value: 'eu', required: true }, photoUrls: { value: ['a', 'b'] }, verbose: { value: false } },
    })
    expect(res).toEqual({})
    expect(await stored()).toEqual({
      petId: { value: 7, required: true }, // the caller said false; the schema says required
      region: { value: 'eu', required: false },
      photoUrls: { value: ['a', 'b'], required: false },
      verbose: { value: false, required: false },
    })
  })

  it('unhiding: saving without a parameter removes it', async () => {
    await updateTool(toolId, { hiddenParams: { petId: { value: 7 }, region: { value: 'eu' } } })
    await updateTool(toolId, { hiddenParams: { petId: { value: 7 } } })
    expect(Object.keys((await stored()) as object)).toEqual(['petId'])
    await updateTool(toolId, { hiddenParams: {} })
    expect(await stored()).toEqual({})
  })

  it('leaves the hidden parameters alone when a save sends only a name or description', async () => {
    await updateTool(toolId, { hiddenParams: { region: { value: 'eu' } } })
    await updateTool(toolId, { description: 'A new description' })
    expect(await stored()).toEqual({ region: { value: 'eu', required: false } })
  })

  it('refuses a required parameter without a value, and names it', async () => {
    for (const value of [undefined, null, '']) {
      const res = await updateTool(toolId, { hiddenParams: { petId: { value } } })
      expect(res).toEqual({ error: 'Hidden required param "petId" must have a fixed value', param: 'petId' })
    }
    expect(await stored()).toEqual({})
  })

  it('an optional parameter with no value is stored as null: never sent', async () => {
    expect(await updateTool(toolId, { hiddenParams: { region: { value: '' }, verbose: { value: undefined } } })).toEqual({})
    expect(await stored()).toEqual({ region: { value: null, required: false }, verbose: { value: null, required: false } })
  })

  it('keeps a value that is false or 0 (they are values, not empty)', async () => {
    expect(await updateTool(toolId, { hiddenParams: { verbose: { value: false } } })).toEqual({})
    expect(await stored()).toEqual({ verbose: { value: false, required: false } })
  })
})

describe('updateTool: the fixed value must fit the parameter', () => {
  const refused = async (name: string, value: unknown) => {
    const res = await updateTool(toolId, { hiddenParams: { [name]: { value } } })
    expect(res.param).toBe(name)
    expect(await stored()).toEqual({})
    return res.error
  }

  it('a string, a number, an integer and a boolean must be of that type', async () => {
    expect(await refused('region', 5)).toBe('Fixed value for "region": Must be text.')
    expect(await refused('petId', '7')).toBe('Fixed value for "petId": Must be a number.')
    expect(await refused('verbose', 'true')).toBe('Fixed value for "verbose": Must be true or false.')
  })

  it('an integer must be whole and within its bounds', async () => {
    expect(await refused('petId', 7.5)).toBe('Fixed value for "petId": Must be a whole number.')
    expect(await refused('petId', 0)).toBe('Fixed value for "petId": Must be at least 1.')
  })

  it('an enum value must be one of the listed values', async () => {
    expect(await refused('status', 'pending')).toBe('Fixed value for "status": Must be one of: "available", "sold".')
    expect(await updateTool(toolId, { hiddenParams: { status: { value: 'sold' } } })).toEqual({})
  })

  it('a list must be a list of the right items', async () => {
    expect(await refused('photoUrls', 'a')).toBe('Fixed value for "photoUrls": Must be a list.')
    expect(await refused('photoUrls', ['a', 3])).toBe('Fixed value for "photoUrls": Item 2: Must be text.')
  })

  it('a name that is not a parameter of the tool is refused (including names that exist on every object)', async () => {
    expect(await refused('nope', 'x')).toBe('"nope" is not a parameter of this tool.')
    expect(await refused('constructor', 'x')).toBe('"constructor" is not a parameter of this tool.')
  })

  it('is all or nothing: one bad parameter saves none, and does not touch the cache', async () => {
    const res = await updateTool(toolId, { hiddenParams: { region: { value: 'eu' }, petId: { value: 'x' } } })
    expect(res.param).toBe('petId')
    expect(await stored()).toEqual({})
    expect(invalidateProject).not.toHaveBeenCalled()
  })
})

describe('updateTool: after saving', () => {
  it('invalidates the gateway cache of the project, once per save', async () => {
    await updateTool(toolId, { hiddenParams: { region: { value: 'eu' } } })
    expect(invalidateProject).toHaveBeenCalledTimes(1)
    expect(invalidateProject).toHaveBeenCalledWith(slug)
    await updateTool(toolId, { hiddenParams: {} })
    expect(invalidateProject).toHaveBeenCalledTimes(2)
  })

  it('the gateway builds the agent schema from the saved row: the hidden parameter and its required entry are gone', async () => {
    await updateTool(toolId, { hiddenParams: { petId: { value: 7 }, region: { value: 'eu' } } })
    const row = await db.tool.findUniqueOrThrow({ where: { id: toolId } })
    // The same call, with the same inputs, that the gateway makes when it loads a project (project-config.ts).
    const agent = toAgentSchema(row.inputSchema as object, row.hiddenParams as object)
    expect(Object.keys(agent.properties ?? {}).sort()).toEqual(['photoUrls', 'status', 'verbose'])
    expect(agent.required).toBeUndefined()
  })

  it('moves the tool version, so the gateway recompiles its validator', async () => {
    const before = (await db.tool.findUniqueOrThrow({ where: { id: toolId } })).updatedAt.getTime()
    await new Promise((r) => setTimeout(r, 5))
    await updateTool(toolId, { hiddenParams: { region: { value: 'eu' } } })
    expect((await db.tool.findUniqueOrThrow({ where: { id: toolId } })).updatedAt.getTime()).toBeGreaterThan(before)
  })
})

describe('updateTool: whose tool', () => {
  it('another user\'s tool is not found, and nothing is written or invalidated', async () => {
    const res = await updateTool(otherToolId, { hiddenParams: { region: { value: 'eu' } } })
    expect(res.error).toBe('Not found')
    expect((await db.tool.findUniqueOrThrow({ where: { id: otherToolId } })).hiddenParams).toEqual({})
    expect(invalidateProject).not.toHaveBeenCalled()
  })
})
