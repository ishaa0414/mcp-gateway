import { describe, expect, it } from 'vitest'
import { DEFAULT_MASK_LIMITS, isSensitiveKey, MASK, maskArguments } from './mask.js'

const size = (v: unknown) => JSON.stringify(v).length
const mask = (args: unknown, schema?: unknown) => maskArguments(args, schema === undefined ? {} : { schema }).value

describe('maskArguments: sensitive keys', () => {
  it.each([
    'authorization',
    'Authorization',
    'password',
    'user_password',
    'passwd',
    'token',
    'accessToken',
    'refresh-token',
    'client_secret',
    'api_key',
    'apiKey',
    'X-Api-Key',
    'cookie',
    'credentials',
    'private_key',
  ])('masks %s', (key) => {
    expect(isSensitiveKey(key)).toBe(true)
    expect(mask({ [key]: 'hunter2', other: 'visible' })).toEqual({ [key]: MASK, other: 'visible' })
  })

  it.each(['name', 'limit', 'petId', 'query', 'author'])('keeps %s', (key) => {
    expect(isSensitiveKey(key)).toBe(false)
  })

  it('masks a whole sensitive subtree without reading it', () => {
    expect(mask({ auth: 1, token: { nested: ['a', 'b'] } })).toEqual({ auth: 1, token: MASK })
  })

  it('masks at any depth, inside arrays too', () => {
    expect(mask({ a: [{ b: { password: 'x', ok: 1 } }] })).toEqual({ a: [{ b: { password: MASK, ok: 1 } }] })
  })
})

describe('maskArguments: schema hints', () => {
  const schema = {
    type: 'object',
    properties: {
      pin: { type: 'string', format: 'password' },
      note: { type: 'string' },
      write: { type: 'string', writeOnly: true },
      nested: { type: 'object', properties: { code: { type: 'string', format: 'password' } } },
      list: { type: 'array', items: { type: 'object', properties: { phrase: { type: 'string', format: 'password' } } } },
      either: { anyOf: [{ type: 'object', properties: { word: { type: 'string', format: 'password' } } }, { type: 'null' }] },
    },
  }

  it('masks format: password and writeOnly properties even when the name looks harmless', () => {
    expect(mask({ pin: '1234', note: 'hi', write: 'w' }, schema)).toEqual({ pin: MASK, note: 'hi', write: MASK })
  })

  it('follows nested objects, array items and anyOf branches', () => {
    expect(mask({ nested: { code: 'c' }, list: [{ phrase: 'p' }], either: { word: 'w' } }, schema)).toEqual({
      nested: { code: MASK },
      list: [{ phrase: MASK }],
      either: { word: MASK },
    })
  })

  it('ignores a schema that is not an object', () => {
    expect(mask({ a: 1 }, 'nonsense')).toEqual({ a: 1 })
  })
})

describe('maskArguments: credential-shaped values', () => {
  it.each([
    ['an API key', 'use mcpg_abcDEF123456xyz please', 'use [MASKED] please'],
    ['a bearer value', 'Authorization: Bearer abc.def-ghi_123', 'Authorization: [MASKED]'],
    ['a basic value', 'Basic dXNlcjpwYXNz', '[MASKED]'],
    ['a JWT', 'jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.c2lnbmF0dXJl done', 'jwt [MASKED] done'],
  ])('masks %s in any string', (_label, input, expected) => {
    expect(mask({ note: input })).toEqual({ note: expected })
  })

  it('leaves ordinary text alone', () => {
    expect(mask({ note: 'the basic implementation is simple, a Basic idea' })).toEqual({ note: 'the basic implementation is simple, a Basic idea' })
  })

  it('masks a credential that sits inside the kept part of a very long string', () => {
    const out = mask({ note: `${'x'.repeat(50)} Bearer sekrit-token-value ${'y'.repeat(5000)}` })['note'] as string
    expect(out).not.toContain('sekrit')
    expect(out).toContain(MASK)
  })
})

describe('maskArguments: shape', () => {
  it('keeps small values as they are', () => {
    const args = { id: 7, tags: ['a', 'b'], on: true, none: null, nested: { x: 1.5 } }
    expect(maskArguments(args)).toEqual({ value: args, truncated: false })
  })

  it('returns {} for missing or non-object arguments', () => {
    expect(mask(undefined)).toEqual({})
    expect(mask('text')).toEqual({})
    expect(mask([1, 2])).toEqual({})
  })

  it('does not change the input', () => {
    const args = { password: 'x', list: [1, 2, 3] }
    mask(args)
    expect(args).toEqual({ password: 'x', list: [1, 2, 3] })
  })

  it('keeps a "__proto__" key as data instead of changing the prototype', () => {
    const parsed = JSON.parse('{"__proto__": {"polluted": true}, "a": 1}') as unknown
    const out = mask(parsed)
    expect(Object.keys(out).sort()).toEqual(['__proto__', 'a'])
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype)
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined()
  })

  it('serialises to JSON without loss for what it keeps', () => {
    const out = mask({ a: 'x', b: [1, { c: null }] })
    expect(JSON.parse(JSON.stringify(out))).toEqual(out)
  })
})

describe('maskArguments: limits', () => {
  it('cuts long strings and says so', () => {
    const { value, truncated } = maskArguments({ text: 'a'.repeat(1000) })
    expect(value['text']).toBe(`${'a'.repeat(DEFAULT_MASK_LIMITS.maxStringChars)}…[truncated]`)
    expect(truncated).toBe(true)
  })

  it('keeps the first items of a long array and counts the rest', () => {
    const { value, truncated } = maskArguments({ list: Array.from({ length: 100 }, (_, i) => i) })
    const list = value['list'] as unknown[]
    expect(list).toHaveLength(DEFAULT_MASK_LIMITS.maxArrayItems + 1)
    expect(list.at(-1)).toBe('[80 more items]')
    expect(truncated).toBe(true)
  })

  it('keeps the first keys of a large object', () => {
    const big = Object.fromEntries(Array.from({ length: 500 }, (_, i) => [`k${i}`, i]))
    const { value, truncated } = maskArguments({ big })
    const kept = value['big'] as Record<string, unknown>
    expect(Object.keys(kept)).toHaveLength(DEFAULT_MASK_LIMITS.maxObjectKeys + 1)
    expect(kept['…']).toBe('[more keys omitted]')
    expect(truncated).toBe(true)
  })

  it('stops at the depth limit', () => {
    let deep: unknown = 'bottom'
    for (let i = 0; i < 50; i++) deep = { next: deep }
    const { value, truncated } = maskArguments(deep)
    expect(JSON.stringify(value)).toContain('[too deep]')
    expect(JSON.stringify(value)).not.toContain('bottom')
    expect(truncated).toBe(true)
  })

  it('keeps the whole result within about the total budget', () => {
    const wide = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`key${i}`, 'v'.repeat(200)]))
    const { value, truncated } = maskArguments({ a: wide, b: wide, c: wide })
    expect(size(value)).toBeLessThan(DEFAULT_MASK_LIMITS.maxTotalChars + 1500)
    expect(truncated).toBe(true)
  })

  it('honours custom limits', () => {
    const { value } = maskArguments({ s: 'abcdefgh' }, { limits: { maxStringChars: 3 } })
    expect(value['s']).toBe('abc…[truncated]')
  })
})

describe('maskArguments: large inputs are not walked in full', () => {
  it('handles a ~1 MB string without storing or scanning it all', () => {
    const started = performance.now()
    const { value, truncated } = maskArguments({ blob: 'z'.repeat(1_000_000) })
    expect(performance.now() - started).toBeLessThan(100)
    expect(size(value)).toBeLessThan(500)
    expect(truncated).toBe(true)
  })

  it('reads at most a few array items out of 100,000', () => {
    let reads = 0
    const list = new Proxy(Array.from({ length: 100_000 }, (_, i) => `item-${i}`), {
      get(target, prop, receiver) {
        if (typeof prop === 'string' && /^\d+$/.test(prop)) reads++
        return Reflect.get(target, prop, receiver)
      },
    })
    const { value, truncated } = maskArguments({ list })
    expect(reads).toBeLessThanOrEqual(DEFAULT_MASK_LIMITS.maxArrayItems)
    expect(size(value)).toBeLessThan(1000)
    expect(truncated).toBe(true)
  })

  it('reads at most maxObjectKeys values out of 50,000', () => {
    let reads = 0
    const big: Record<string, unknown> = {}
    for (let i = 0; i < 50_000; i++) {
      Object.defineProperty(big, `key${i}`, {
        enumerable: true,
        get() {
          reads++
          return 'v'.repeat(20)
        },
      })
    }
    const { value, truncated } = maskArguments({ big })
    expect(reads).toBeLessThanOrEqual(DEFAULT_MASK_LIMITS.maxObjectKeys)
    expect(size(value)).toBeLessThan(2000)
    expect(truncated).toBe(true)
  })

  it('a realistic ~1 MB JSON argument (many nested records) is cut and quick', () => {
    const records = Array.from({ length: 5000 }, (_, i) => ({ id: i, name: `name-${i}`, notes: 'n'.repeat(150), tags: ['a', 'b', 'c'] }))
    const json = JSON.stringify({ records })
    expect(json.length).toBeGreaterThan(900_000)
    const parsed = JSON.parse(json) as unknown

    const started = performance.now()
    const { value, truncated } = maskArguments(parsed)
    expect(performance.now() - started).toBeLessThan(100)
    expect(size(value)).toBeLessThan(DEFAULT_MASK_LIMITS.maxTotalChars + 1500)
    expect(truncated).toBe(true)
  })

  it('stops spending once the budget is gone, even with many small values', () => {
    let reads = 0
    const rows = Array.from({ length: 20 }, () =>
      Object.fromEntries(
        Array.from({ length: 50 }, (_, i) => [
          `field${i}`,
          new Proxy({ x: 'y'.repeat(100) }, {
            get(t, p, r) {
              reads++
              return Reflect.get(t, p, r)
            },
          }),
        ])
      )
    )
    maskArguments({ rows })
    // 20 rows × 50 fields = 1000 possible; the 4 KB budget ends the walk long before.
    expect(reads).toBeLessThan(400)
  })
})
