import { describe, it, expect } from 'vitest'
import { mergeTools } from './merge.js'
import type { ToolDefinition } from './types.js'
import type { ExistingTool } from './merge.js'

function makeFresh(overrides: Partial<ToolDefinition> = {}): ToolDefinition {
  return {
    operationId: 'getUser',
    method: 'GET',
    path: '/users/{id}',
    name: 'getUser',
    description: 'Get a user',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    ...overrides,
  }
}

function makeExisting(overrides: Partial<ExistingTool> = {}): ExistingTool {
  return {
    operationId: 'getUser',
    name: 'getUser',
    description: 'Get a user',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    enabled: true,
    hiddenParams: {},
    removedAt: null,
    ...overrides,
  }
}

describe('mergeTools', () => {
  it('adds new operations not in existing list', () => {
    const result = mergeTools([], [makeFresh()])
    expect(result.added).toBe(1)
    expect(result.tools).toHaveLength(1)
    expect(result.tools[0]?.removedAt).toBeNull()
  })

  it('marks operations removed when missing from fresh spec', () => {
    const existing = [makeExisting()]
    const result = mergeTools(existing, [])
    expect(result.removed).toBe(1)
    expect(result.tools[0]?.removedAt).toBeInstanceOf(Date)
  })

  it('keeps already-removed tools as unchanged', () => {
    const existing = [makeExisting({ removedAt: new Date('2025-01-01') })]
    const result = mergeTools(existing, [])
    expect(result.removed).toBe(0)
    expect(result.unchanged).toBe(1)
    expect(result.tools[0]?.removedAt).toEqual(new Date('2025-01-01'))
  })

  it('clears removedAt when operation re-appears in spec', () => {
    const existing = [makeExisting({ removedAt: new Date('2025-01-01') })]
    const result = mergeTools(existing, [makeFresh()])
    expect(result.updated).toBe(1)
    expect(result.tools[0]?.removedAt).toBeNull()
  })

  it('updates inputSchema from fresh spec', () => {
    const existing = [makeExisting()]
    const fresh = makeFresh({
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'string' }, expand: { type: 'boolean' } },
        required: ['id'],
      },
    })
    const result = mergeTools(existing, [fresh])
    expect(result.updated).toBe(1)
    expect(result.tools[0]?.inputSchema.properties).toHaveProperty('expand')
  })

  it('preserves user-edited name and description', () => {
    const existing = [makeExisting({ name: 'myCustomName', description: 'My custom desc', userEdited: true })]
    const fresh = makeFresh({ name: 'getUser', description: 'Get a user' })
    const result = mergeTools(existing, [fresh])
    expect(result.tools[0]?.name).toBe('myCustomName')
    expect(result.tools[0]?.description).toBe('My custom desc')
  })

  it('updates name and description when not user-edited', () => {
    const existing = [makeExisting({ name: 'getUser', description: 'Old desc', userEdited: false })]
    const fresh = makeFresh({ name: 'fetchUser', description: 'New desc' })
    const result = mergeTools(existing, [fresh])
    expect(result.tools[0]?.name).toBe('fetchUser')
    expect(result.tools[0]?.description).toBe('New desc')
  })

  it('counts unchanged when nothing changed', () => {
    const existing = [makeExisting()]
    const fresh = [makeFresh()]
    const result = mergeTools(existing, fresh)
    expect(result.unchanged).toBe(1)
    expect(result.updated).toBe(0)
    expect(result.added).toBe(0)
    expect(result.removed).toBe(0)
  })

  it('handles mix of add, update, remove', () => {
    const existing = [
      makeExisting({ operationId: 'oldOp', name: 'oldOp' }),
      makeExisting({ operationId: 'stayOp', name: 'stayOp' }),
    ]
    const fresh = [
      makeFresh({ operationId: 'stayOp', name: 'stayOp' }),
      makeFresh({ operationId: 'newOp', name: 'newOp' }),
    ]
    const result = mergeTools(existing, fresh)
    expect(result.added).toBe(1)
    expect(result.removed).toBe(1)
    expect(result.tools).toHaveLength(3)
  })
})
