import { describe, expect, it } from 'vitest'
import { toAgentSchema } from './agent-schema.js'

const full = {
  type: 'object',
  properties: { id: { type: 'string' }, tenant: { type: 'string' }, limit: { type: 'integer' } },
  required: ['id', 'tenant'],
}

describe('toAgentSchema', () => {
  it('returns the schema unchanged when nothing is hidden', () => {
    expect(toAgentSchema(full, {})).toBe(full)
  })

  it('removes hidden properties and drops them from required', () => {
    expect(toAgentSchema(full, { tenant: { value: 'acme', required: true } })).toEqual({
      type: 'object',
      properties: { id: { type: 'string' }, limit: { type: 'integer' } },
      required: ['id'],
    })
  })

  it('omits required entirely when every required field is hidden', () => {
    const result = toAgentSchema(full, { id: { value: 1 }, tenant: { value: 'a' } })
    expect(result).toEqual({ type: 'object', properties: { limit: { type: 'integer' } } })
    expect('required' in result).toBe(false)
  })

  it('ignores hidden names the schema does not have, and does not mutate its input', () => {
    const copy = structuredClone(full)
    expect(toAgentSchema(full, { nope: { value: 1 } }).properties).toEqual(full.properties)
    expect(full).toEqual(copy)
  })

  it('handles a schema with no properties', () => {
    expect(toAgentSchema({ type: 'object' }, { a: { value: 1 } })).toEqual({ type: 'object', properties: {} })
  })
})
