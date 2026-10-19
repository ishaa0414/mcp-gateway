import { toAgentSchema } from '@mcp-gateway/openapi-tools'
import { describe, expect, it } from 'vitest'
import { buildFields, toArguments, toFieldText, type PlaygroundField } from '@/lib/playground/fields'

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

  it('falls back to a JSON field for objects, unions, several types, no type, and enums of non-scalars', () => {
    expect(kinds).toMatchObject({ tags: 'list', owner: 'json', either: 'json', anything: 'json', maybe: 'json', mixedEnum: 'json' })
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
    expect(args({ petId: '7', price: '9.5', name: 'Rex', sold: 'false', status: '1', level: '2', tags: 'a\nb', owner: ' {"id": 3} ', price2: 'ignored' })).toEqual({
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
    const result = args({ owner: '{"id": ', price: '1' })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(Object.keys(result.errors)).toEqual(['owner'])
      expect(result.errors['owner']).toMatch(/^Not valid JSON: /)
    }
  })

  it('reports a chosen option that does not exist', () => {
    expect(args({ status: '9' })).toEqual({ ok: false, errors: { status: 'Choose one of the listed values.' } })
  })
})

describe('lists of plain values', () => {
  const listSchema = (items: unknown) => buildFields({ type: 'object', properties: { xs: { type: 'array', items } } })[0]!

  it('an array of strings, numbers, integers or booleans is a list with that item type', () => {
    for (const type of ['string', 'number', 'integer', 'boolean']) {
      expect(listSchema({ type })).toMatchObject({ kind: 'list', itemKind: type })
    }
    expect(listSchema({ type: 'string', format: 'uri' })).toMatchObject({ kind: 'list', itemKind: 'string' })
  })

  it('stays JSON for items with a choice, objects, nested arrays, unions and a missing item type', () => {
    for (const items of [{ type: 'string', enum: ['a', 'b'] }, { type: 'object' }, { type: 'array', items: { type: 'string' } }, { oneOf: [{ type: 'string' }] }, {}, undefined]) {
      expect(listSchema(items).kind).toBe('json')
    }
  })

  const field = listSchema({ type: 'string' })
  const numbers = listSchema({ type: 'integer' })
  const booleans = listSchema({ type: 'boolean' })

  it('takes one value per line, trimmed, ignoring blank lines and Windows line ends', () => {
    expect(toArguments([field], { xs: ' https://example.com/a.jpg \r\n\r\n  \nhttps://example.com/b.jpg\n' })).toEqual({
      ok: true,
      arguments: { xs: ['https://example.com/a.jpg', 'https://example.com/b.jpg'] },
    })
  })

  it('leaves the field out when it holds no value', () => {
    expect(toArguments([field], { xs: '\n  \n' })).toEqual({ ok: true, arguments: {} })
  })

  it('reads numbers and booleans per line, and names the line that does not fit', () => {
    expect(toArguments([numbers], { xs: '1\n2.5\n-3' })).toEqual({ ok: true, arguments: { xs: [1, 2.5, -3] } })
    expect(toArguments([booleans], { xs: 'true\nfalse' })).toEqual({ ok: true, arguments: { xs: [true, false] } })
    expect(toArguments([numbers], { xs: '1\nabc\n3' })).toEqual({ ok: false, errors: { xs: 'Line 2 is not a number.' } })
    expect(toArguments([booleans], { xs: 'true\nyes' })).toEqual({ ok: false, errors: { xs: 'Line 2 is not true or false.' } })
  })
})

describe('toFieldText: a stored value back to form text', () => {
  const fields = buildFields(schema)
  const byName = (name: string) => fields.find((f) => f.name === name)!

  it('is the reverse of toArguments for each kind', () => {
    const values = { petId: 7, price: 9.5, name: 'Rex', sold: false, status: 'pending', level: 3, tags: ['a', 'b'], owner: { id: 3 } }
    const text = Object.fromEntries(Object.entries(values).map(([name, value]) => [name, toFieldText(byName(name), value)]))
    expect(text).toMatchObject({ petId: '7', price: '9.5', name: 'Rex', sold: 'false', status: '1', level: '2', tags: 'a\nb' })
    expect(toArguments(fields, text)).toEqual({ ok: true, arguments: values })
  })

  it('is empty for null, undefined and a value that is not one of the options', () => {
    expect(toFieldText(byName('name'), null)).toBe('')
    expect(toFieldText(byName('name'), undefined)).toBe('')
    expect(toFieldText(byName('status'), 'unknown')).toBe('')
  })
})
