import { toAgentSchema } from '@mcp-gateway/openapi-tools'
import { describe, expect, it } from 'vitest'
import { draftToHiddenParams, initialDraft, REQUIRED_NEEDS_VALUE, type HiddenDraft } from '@/lib/tool-editor/hidden-params'
import { checkParamValue } from '@/lib/tool-editor/value-check'

const schema = {
  type: 'object',
  required: ['petId'],
  properties: {
    petId: { type: 'integer', minimum: 1, maximum: 1000 },
    region: { type: 'string' },
    status: { type: 'string', enum: ['available', 'sold'] },
    verbose: { type: 'boolean' },
    photoUrls: { type: 'array', items: { type: 'string' } },
    filter: { type: 'object' },
  },
}

const hide = (rows: Record<string, string>): HiddenDraft => Object.fromEntries(Object.entries(rows).map(([name, text]) => [name, { hidden: true, text }]))

describe('checkParamValue', () => {
  it('accepts a value of the right type and refuses one of another', () => {
    expect(checkParamValue({ type: 'string' }, 'x')).toBeNull()
    expect(checkParamValue({ type: 'string' }, 5)).toBe('Must be text.')
    expect(checkParamValue({ type: 'number' }, 1.5)).toBeNull()
    expect(checkParamValue({ type: 'number' }, '1.5')).toBe('Must be a number.')
    expect(checkParamValue({ type: 'boolean' }, false)).toBeNull()
    expect(checkParamValue({ type: 'boolean' }, 'false')).toBe('Must be true or false.')
    expect(checkParamValue({ type: 'object' }, { a: 1 })).toBeNull()
    expect(checkParamValue({ type: 'object' }, [1])).toBe('Must be a JSON object.')
  })

  it('an integer must be a whole number, and within minimum and maximum', () => {
    expect(checkParamValue({ type: 'integer' }, 7)).toBeNull()
    expect(checkParamValue({ type: 'integer' }, 7.5)).toBe('Must be a whole number.')
    expect(checkParamValue({ type: 'integer', minimum: 1 }, 0)).toBe('Must be at least 1.')
    expect(checkParamValue({ type: 'integer', maximum: 9 }, 10)).toBe('Must be at most 9.')
    expect(checkParamValue({ type: 'number' }, Number.POSITIVE_INFINITY)).toBe('Must be a number.')
  })

  it('an enum value must be one of the listed ones, whatever its type', () => {
    expect(checkParamValue({ type: 'string', enum: ['a', 'b'] }, 'a')).toBeNull()
    expect(checkParamValue({ type: 'string', enum: ['a', 'b'] }, 'c')).toBe('Must be one of: "a", "b".')
    expect(checkParamValue({ enum: [1, 2] }, 2)).toBeNull()
    expect(checkParamValue({ enum: [1, 2] }, '2')).toMatch(/^Must be one of/)
  })

  it('an array is checked item by item', () => {
    const urls = { type: 'array', items: { type: 'string' } }
    expect(checkParamValue(urls, ['a', 'b'])).toBeNull()
    expect(checkParamValue(urls, 'a')).toBe('Must be a list.')
    expect(checkParamValue(urls, ['a', 2])).toBe('Item 2: Must be text.')
  })

  it('has nothing to say about a schema it does not understand', () => {
    expect(checkParamValue(undefined, 'x')).toBeNull()
    expect(checkParamValue({}, 5)).toBeNull()
    expect(checkParamValue({ oneOf: [{ type: 'string' }] }, 5)).toBeNull()
  })
})

describe('the Parameters draft', () => {
  it('starts with nothing hidden, and with the stored hidden parameters on (their values as text)', () => {
    const plain = initialDraft(schema, {})
    expect(Object.values(plain).every((row) => !row.hidden)).toBe(true)
    expect(Object.keys(plain).sort()).toEqual(['filter', 'petId', 'photoUrls', 'region', 'status', 'verbose'])

    const stored = initialDraft(schema, { region: { value: 'eu', required: false }, status: { value: 'sold' }, photoUrls: { value: ['a', 'b'] }, verbose: { value: null } })
    expect(stored['region']).toEqual({ hidden: true, text: 'eu' })
    expect(stored['status']).toEqual({ hidden: true, text: '1' }) // the index of "sold"
    expect(stored['photoUrls']).toEqual({ hidden: true, text: 'a\nb' })
    expect(stored['verbose']).toEqual({ hidden: true, text: '' }) // fixed to "never send"
    expect(stored['petId']!.hidden).toBe(false)
  })

  it('hides a parameter with a typed value, and records whether the schema requires it', () => {
    const result = draftToHiddenParams(schema, hide({ petId: '7', region: 'eu', status: '0', verbose: 'true', photoUrls: 'a\nb', filter: '{"x": 1}' }))
    expect(result).toEqual({
      ok: true,
      hiddenParams: {
        petId: { value: 7, required: true },
        region: { value: 'eu', required: false },
        status: { value: 'available', required: false },
        verbose: { value: true, required: false },
        photoUrls: { value: ['a', 'b'], required: false },
        filter: { value: { x: 1 }, required: false },
      },
    })
  })

  it('unhiding removes the parameter from what is saved', () => {
    const draft: HiddenDraft = { ...hide({ region: 'eu' }), petId: { hidden: false, text: '7' } }
    const result = draftToHiddenParams(schema, draft)
    expect(result).toEqual({ ok: true, hiddenParams: { region: { value: 'eu', required: false } } })
    expect(draftToHiddenParams(schema, { region: { hidden: false, text: 'eu' } })).toEqual({ ok: true, hiddenParams: {} })
  })

  it('refuses to hide a required parameter without a value, naming that parameter', () => {
    expect(draftToHiddenParams(schema, hide({ petId: '   ', region: 'eu' }))).toEqual({ ok: false, errors: { petId: REQUIRED_NEEDS_VALUE } })
  })

  it('an optional parameter hidden with no value is kept, with the value null: never sent', () => {
    expect(draftToHiddenParams(schema, hide({ region: '' }))).toEqual({ ok: true, hiddenParams: { region: { value: null, required: false } } })
  })

  it('reports a value of the wrong type, per parameter', () => {
    const result = draftToHiddenParams(schema, hide({ petId: '7.5', verbose: 'maybe', photoUrls: 'a', filter: '[1]', status: '9', region: 'ok' }))
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.errors['petId']).toBe('Must be a whole number.')
      expect(result.errors['verbose']).toBeUndefined() // a boolean is chosen from a list, so "maybe" is not a value the form can hold
      expect(result.errors['filter']).toBe('Must be a JSON object.')
      expect(result.errors['status']).toBe('Choose one of the listed values.')
      expect(result.errors['region']).toBeUndefined()
      expect(result.errors['photoUrls']).toBeUndefined()
    }
  })

  it('reports text that is not a number or not JSON, and a number outside its bounds', () => {
    const result = draftToHiddenParams(schema, hide({ petId: 'abc', filter: '{', region: 'x' }))
    expect(result).toMatchObject({ ok: false, errors: { petId: 'Enter a number.' } })
    expect(draftToHiddenParams(schema, hide({ petId: '0' }))).toEqual({ ok: false, errors: { petId: 'Must be at least 1.' } })
    expect(draftToHiddenParams(schema, hide({ petId: '5000' }))).toEqual({ ok: false, errors: { petId: 'Must be at most 1000.' } })
  })

  it('what the agent sees follows the draft: hidden parameters, and their required entries, are gone', () => {
    const draft = hide({ petId: '7', region: 'eu' })
    const names = Object.entries(draft).filter(([, row]) => row.hidden).map(([name]) => name)
    const agent = toAgentSchema(schema, Object.fromEntries(names.map((n) => [n, {}])))
    expect(Object.keys(agent.properties ?? {}).sort()).toEqual(['filter', 'photoUrls', 'status', 'verbose'])
    expect(agent.required).toBeUndefined()
  })
})
