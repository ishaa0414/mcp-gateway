import { toAgentSchema } from '@mcp-gateway/openapi-tools'
import { describe, expect, it } from 'vitest'
import { buildFields, toArguments, type PlaygroundField } from '@/lib/playground/fields'

const schema = {
  type: 'object',
  required: ['petId', 'name'],
  properties: {
    petId: { type: 'integer', description: 'The pet' },
    price: { type: 'number' },
    name: { type: 'string' },
    sold: { type: 'boolean' },
    status: { type: 'string', enum: ['available', 'pending', 'sold'] },
    level: { enum: [1, 2, 3] },
    tags: { type: 'array', items: { type: 'string' } },
    owner: { type: 'object', properties: { id: { type: 'integer' } } },
    either: { oneOf: [{ type: 'string' }, { type: 'integer' }] },
    anything: {},
    maybe: { type: ['string', 'null'] },
    mixedEnum: { enum: ['a', { x: 1 }] },
  },
}

const kinds = Object.fromEntries(buildFields(schema).map((f) => [f.name, f.kind]))

describe('buildFields', () => {
  it('gives scalars their own control', () => {
    expect(kinds).toMatchObject({ petId: 'integer', price: 'number', name: 'string', sold: 'boolean', status: 'enum', level: 'enum' })
  })

  it('keeps an enum to its listed values, whatever their type', () => {
    const fields = buildFields(schema)
    expect(fields.find((f) => f.name === 'status')?.options).toEqual(['available', 'pending', 'sold'])
    expect(fields.find((f) => f.name === 'level')?.options).toEqual([1, 2, 3])
  })

  it('falls back to a JSON field for objects, arrays, unions, several types, no type, and enums of non-scalars', () => {
    expect(kinds).toMatchObject({ tags: 'json', owner: 'json', either: 'json', anything: 'json', maybe: 'json', mixedEnum: 'json' })
  })

  it('marks required fields and carries descriptions', () => {
    const fields = buildFields(schema)
    expect(fields.filter((f) => f.required).map((f) => f.name)).toEqual(['petId', 'name'])
    expect(fields.find((f) => f.name === 'petId')?.description).toBe('The pet')
  })

  it('lists required fields first, then the others in their order', () => {
    const fields = buildFields({
      type: 'object',
      required: ['z', 'm'],
      properties: { a: { type: 'string' }, z: { type: 'string' }, b: { type: 'string' }, m: { type: 'string' } },
    })
    expect(fields.map((f) => f.name)).toEqual(['z', 'm', 'a', 'b'])
  })

  it('returns no fields for a schema without properties, or something that is not a schema', () => {
    expect(buildFields({ type: 'object', properties: {} })).toEqual([])
    expect(buildFields({ type: 'object' })).toEqual([])
    expect(buildFields(null)).toEqual([])
    expect(buildFields('nope')).toEqual([])
  })

  it('has no field for a hidden parameter when built from the agent schema', () => {
    const hidden = { petId: { value: 7 }, name: { value: 'secret-name' } }
    const names = buildFields(toAgentSchema(schema, hidden)).map((f) => f.name)
    expect(names).not.toContain('petId')
    expect(names).not.toContain('name')
    expect(names).toContain('price')
  })
})

describe('toArguments', () => {
  const fields: PlaygroundField[] = buildFields(schema)
  const args = (values: Record<string, string>) => toArguments(fields, values)

  it('converts each kind to its type and leaves blank fields out', () => {
    expect(args({ petId: '7', price: '9.5', name: 'Rex', sold: 'false', status: '1', level: '2', tags: '["a","b"]', owner: ' {"id": 3} ', price2: 'ignored' })).toEqual({
      ok: true,
      arguments: { petId: 7, price: 9.5, name: 'Rex', sold: false, status: 'pending', level: 3, tags: ['a', 'b'], owner: { id: 3 } },
    })
    expect(args({ petId: '', name: '   ', sold: '' })).toEqual({ ok: true, arguments: {} })
  })

  it('sends a string as typed, including spaces', () => {
    expect(args({ name: ' Rex the 2nd ' })).toEqual({ ok: true, arguments: { name: ' Rex the 2nd ' } })
  })

  it('does not decide whether a number is an integer or in range: that is the gateway check, shown as it says it', () => {
    expect(args({ petId: '1.5' })).toEqual({ ok: true, arguments: { petId: 1.5 } })
  })

  it('reports text that is not a number, per field', () => {
    expect(args({ petId: 'seven', price: 'abc' })).toEqual({ ok: false, errors: { petId: 'Enter a number.', price: 'Enter a number.' } })
  })

  it('reports JSON that does not parse, with the parser message', () => {
    const result = args({ tags: '[1, 2', owner: '{"id": 3}' })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(Object.keys(result.errors)).toEqual(['tags'])
      expect(result.errors['tags']).toMatch(/^Not valid JSON: /)
    }
  })

  it('reports a chosen option that does not exist', () => {
    expect(args({ status: '9' })).toEqual({ ok: false, errors: { status: 'Choose one of the listed values.' } })
  })
})
