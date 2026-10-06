import { describe, it, expect } from 'vitest'
import { isDeepEqual, mergeTools } from './merge.js'
import type { ExistingTool } from './merge.js'
import type { ToolDefinition } from './types.js'

const schema = { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] }

function makeFresh(overrides: Partial<ToolDefinition> = {}): ToolDefinition {
  return {
    operationId: 'getUser',
    method: 'GET',
    path: '/users/{id}',
    name: 'getUser',
    description: 'Get a user',
    inputSchema: schema,
    ...overrides,
  }
}

/** A stored row that matches `makeFresh()` exactly, i.e. an untouched import. */
function makeExisting(overrides: Partial<ExistingTool> = {}): ExistingTool {
  return {
    operationId: 'getUser',
    method: 'GET',
    path: '/users/{id}',
    name: 'getUser',
    description: 'Get a user',
    specName: 'getUser',
    specDescription: 'Get a user',
    inputSchema: schema,
    removedAt: null,
    ...overrides,
  }
}

describe('isDeepEqual', () => {
  it('ignores object key order at every depth', () => {
    const a = { type: 'object', properties: { a: { type: 'string', enum: ['x'] }, b: { type: 'number' } } }
    const b = { properties: { b: { type: 'number' }, a: { enum: ['x'], type: 'string' } }, type: 'object' }
    expect(isDeepEqual(a, b)).toBe(true)
  })

  it('respects array order and detects value differences', () => {
    expect(isDeepEqual({ r: ['a', 'b'] }, { r: ['b', 'a'] })).toBe(false)
    expect(isDeepEqual({ a: 1 }, { a: 2 })).toBe(false)
    expect(isDeepEqual({ a: 1 }, { a: 1, b: 2 })).toBe(false)
    expect(isDeepEqual({ a: undefined }, { b: undefined })).toBe(false)
    expect(isDeepEqual([], {})).toBe(false)
  })
})

describe('mergeTools: adding and removing', () => {
  it('creates operations that are not stored yet', () => {
    const result = mergeTools([], [makeFresh()])
    expect(result.added).toBe(1)
    expect(result.create).toHaveLength(1)
    expect(result.update).toHaveLength(0)
  })

  it('marks active operations removed when they leave the spec', () => {
    const result = mergeTools([makeExisting()], [])
    expect(result.removed).toBe(1)
    expect(result.markRemoved).toEqual(['getUser'])
  })

  it('leaves already-removed tools alone and counts them unchanged', () => {
    const result = mergeTools([makeExisting({ removedAt: new Date('2025-01-01') })], [])
    expect(result.removed).toBe(0)
    expect(result.unchanged).toBe(1)
    expect(result.markRemoved).toEqual([])
  })

  it('restores a removed tool when the operation reappears', () => {
    const result = mergeTools([makeExisting({ removedAt: new Date('2025-01-01') })], [makeFresh()])
    expect(result.updated).toBe(1)
    expect(result.update[0]?.operationId).toBe('getUser')
  })
})

describe('mergeTools: re-importing an identical spec', () => {
  it('reports everything unchanged and writes nothing', () => {
    const existing = [makeExisting(), makeExisting({ operationId: 'listUsers', path: '/users' })]
    const fresh = [makeFresh(), makeFresh({ operationId: 'listUsers', path: '/users' })]

    const result = mergeTools(existing, fresh)

    expect(result).toMatchObject({ added: 0, updated: 0, removed: 0, unchanged: 2 })
    expect(result.create).toEqual([])
    expect(result.update).toEqual([])
    expect(result.markRemoved).toEqual([])
  })

  it('is not fooled by key reordering from the JSONB round trip', () => {
    const reordered = { required: ['id'], properties: { id: { type: 'string' } }, type: 'object' }
    const result = mergeTools([makeExisting({ inputSchema: reordered })], [makeFresh()])
    expect(result.updated).toBe(0)
    expect(result.unchanged).toBe(1)
  })

  it('does not count a user-edited name or description as an update', () => {
    const existing = [makeExisting({ name: 'find_user', description: 'My words' })]
    const result = mergeTools(existing, [makeFresh()])
    expect(result.updated).toBe(0)
    expect(result.unchanged).toBe(1)
  })
})

describe('mergeTools: spec changes', () => {
  it('updates inputSchema from the fresh spec', () => {
    const fresh = makeFresh({
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'string' }, expand: { type: 'boolean' } },
        required: ['id'],
      },
    })
    const result = mergeTools([makeExisting()], [fresh])
    expect(result.updated).toBe(1)
    expect(result.update[0]?.inputSchema.properties).toHaveProperty('expand')
  })

  it('takes method and path changes from the spec', () => {
    const result = mergeTools([makeExisting()], [makeFresh({ method: 'POST', path: '/people/{id}' })])
    expect(result.update[0]).toMatchObject({ method: 'POST', path: '/people/{id}' })
  })

  it('follows the spec for fields the user never edited', () => {
    const result = mergeTools([makeExisting()], [makeFresh({ name: 'fetchUser', description: 'New desc' })])
    expect(result.update[0]).toMatchObject({
      name: 'fetchUser',
      description: 'New desc',
      specName: 'fetchUser',
      specDescription: 'New desc',
    })
  })

  it('keeps a user-edited name and description but still advances the baseline', () => {
    const existing = [makeExisting({ name: 'find_user', description: 'My words' })]
    const fresh = makeFresh({ name: 'fetchUser', description: 'New desc' })

    const [u] = mergeTools(existing, [fresh]).update

    expect(u).toMatchObject({ name: 'find_user', description: 'My words' })
    expect(u?.specName).toBe('fetchUser')
    expect(u?.specDescription).toBe('New desc')
  })

  it('treats name and description independently', () => {
    const existing = [makeExisting({ name: 'find_user' })]
    const [u] = mergeTools(existing, [makeFresh({ name: 'fetchUser', description: 'New desc' })]).update
    expect(u).toMatchObject({ name: 'find_user', description: 'New desc' })
  })

  it('handles a mix of add, update, remove and unchanged', () => {
    const existing = [
      makeExisting({ operationId: 'oldOp' }),
      makeExisting({ operationId: 'stayOp' }),
      makeExisting({ operationId: 'changedOp' }),
    ]
    const fresh = [
      makeFresh({ operationId: 'stayOp' }),
      makeFresh({ operationId: 'changedOp', description: 'Different' }),
      makeFresh({ operationId: 'newOp' }),
    ]
    const result = mergeTools(existing, fresh)
    expect(result).toMatchObject({ added: 1, updated: 1, removed: 1, unchanged: 1 })
  })
})

describe('mergeTools: name collisions', () => {
  // A tool the user renamed from getPetById to find_pet.
  const userRenamed = () =>
    makeExisting({ operationId: 'getPetById', path: '/pet/{id}', name: 'find_pet', specName: 'getPetById' })
  const specFor = (...ops: Array<Partial<ToolDefinition>>) => ops.map((o) => makeFresh(o))
  const petFresh = { operationId: 'getPetById', path: '/pet/{id}', name: 'getPetById' }

  it('keeps the user name and suffixes a new tool that wants it', () => {
    const fresh = specFor(petFresh, { operationId: 'findPet', path: '/find', name: 'find_pet' })

    const result = mergeTools([userRenamed()], fresh)

    expect(result.create).toHaveLength(1)
    expect(result.create[0]).toMatchObject({ name: 'find_pet_2', specName: 'find_pet' })
    expect(result.collisions).toEqual([{ operationId: 'findPet', wanted: 'find_pet', assigned: 'find_pet_2' }])
    expect(result.update).toEqual([]) // the user's tool is not touched
  })

  it('gives the user the name even when the new operation comes first in the spec', () => {
    const fresh = specFor({ operationId: 'findPet', path: '/find', name: 'find_pet' }, petFresh)
    const result = mergeTools([userRenamed()], fresh)
    expect(result.create[0]?.name).toBe('find_pet_2')
  })

  it('walks past suffixes that are also taken', () => {
    const existing = [
      makeExisting({ operationId: 'a', name: 'x', specName: 'a' }),
      makeExisting({ operationId: 'b', name: 'x_2', specName: 'b' }),
    ]
    const fresh = specFor(
      { operationId: 'a', name: 'a' },
      { operationId: 'b', name: 'b' },
      { operationId: 'c', name: 'x' }
    )
    expect(mergeTools(existing, fresh).create[0]?.name).toBe('x_3')
  })

  it('keeps a suffixed name within 64 characters', () => {
    const long = 'n'.repeat(64)
    const existing = [makeExisting({ operationId: 'a', name: long, specName: 'a' })]
    const fresh = specFor({ operationId: 'a', name: 'a' }, { operationId: 'b', name: long })

    const assigned = mergeTools(existing, fresh).create[0]!.name

    expect(assigned).toHaveLength(64)
    expect(assigned.endsWith('_2')).toBe(true)
    expect(assigned).not.toBe(long)
  })

  it('suffixes an existing, unedited tool whose spec name moved onto a taken name', () => {
    const existing = [
      userRenamed(),
      makeExisting({ operationId: 'findPet', path: '/find', name: 'findPet', specName: 'findPet' }),
    ]
    const fresh = specFor(petFresh, { operationId: 'findPet', path: '/find', name: 'find_pet' })

    const result = mergeTools(existing, fresh)

    expect(result.update).toHaveLength(1)
    expect(result.update[0]).toMatchObject({ operationId: 'findPet', name: 'find_pet_2', specName: 'find_pet' })
    expect(result.collisions).toHaveLength(1)
  })

  it('lets two unedited tools swap spec names without a collision', () => {
    const existing = [
      makeExisting({ operationId: 'a', name: 'x', specName: 'x' }),
      makeExisting({ operationId: 'b', name: 'y', specName: 'y' }),
    ]
    const fresh = specFor({ operationId: 'a', name: 'y' }, { operationId: 'b', name: 'x' })

    const result = mergeTools(existing, fresh)

    expect(result.collisions).toEqual([])
    expect(Object.fromEntries(result.update.map((u) => [u.operationId, u.name]))).toEqual({ a: 'y', b: 'x' })
  })

  it('treats the name of a removed tool as taken', () => {
    const existing = [makeExisting({ operationId: 'gone', name: 'listPets', specName: 'listPets', removedAt: new Date() })]
    const result = mergeTools(existing, specFor({ operationId: 'other', name: 'listPets' }))
    expect(result.create[0]?.name).toBe('listPets_2')
  })

  it('reports nothing when names do not clash', () => {
    const result = mergeTools([makeExisting()], specFor({}, { operationId: 'other', name: 'other' }))
    expect(result.collisions).toEqual([])
  })

  it('is stable: re-importing after a collision changes nothing', () => {
    // State after the first import above: user owns find_pet, the new tool holds find_pet_2.
    const existing = [
      userRenamed(),
      makeExisting({ operationId: 'findPet', path: '/find', name: 'find_pet_2', specName: 'find_pet' }),
    ]
    const fresh = specFor(petFresh, { operationId: 'findPet', path: '/find', name: 'find_pet' })

    const result = mergeTools(existing, fresh)

    expect(result).toMatchObject({ added: 0, updated: 0, removed: 0, unchanged: 2, collisions: [] })
  })
})
