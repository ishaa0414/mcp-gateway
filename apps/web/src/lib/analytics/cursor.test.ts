import { describe, it, expect } from 'vitest'
import { decodeCursor, encodeCursor } from './cursor'
import { parseRange, RANGE_PLANS } from './range'

describe('cursor', () => {
  const cursor = { createdAt: '2026-10-12T10:00:00.123000', id: 'seed_abc_12' }

  it('round-trips with full timestamp precision', () => {
    const micro = { createdAt: '2026-10-12T10:00:00.123456', id: 'x' }
    expect(decodeCursor(encodeCursor(cursor))).toEqual(cursor)
    expect(decodeCursor(encodeCursor(micro))).toEqual(micro)
  })

  it('is URL-safe', () => {
    expect(encodeCursor(cursor)).toMatch(/^[A-Za-z0-9_-]+$/)
  })

  it.each([
    undefined, null, 5, '', 'not a cursor', 'a'.repeat(300),
    encodeCursor({ createdAt: '2026-10-12 10:00:00', id: 'x' }),
    encodeCursor({ createdAt: '2026-13-01T00:00:00.000000', id: 'x' }),
    encodeCursor({ createdAt: '2026-02-30T00:00:00.000000', id: 'x' }),
    encodeCursor({ createdAt: '2026-10-12T25:00:00.000000', id: 'x' }),
    encodeCursor({ createdAt: '2026-10-12T10:00:00.123000', id: '' }),
    encodeCursor({ createdAt: '2026-10-12T10:00:00.123000', id: 'i'.repeat(65) }),
  ])('rejects %j', (value) => {
    expect(decodeCursor(value)).toBeNull()
  })
})

describe('range', () => {
  it('parses the three ranges and defaults to 7 d', () => {
    expect(parseRange('24h')).toBe('24h')
    expect(parseRange('30d')).toBe('30d')
    for (const v of [undefined, '', '90d', '7D', 7, null]) expect(parseRange(v)).toBe('7d')
  })

  it('buckets by hour for 24 h and by day otherwise', () => {
    expect(RANGE_PLANS['24h']).toEqual({ unit: 'hour', buckets: 24 })
    expect(RANGE_PLANS['7d']).toEqual({ unit: 'day', buckets: 7 })
    expect(RANGE_PLANS['30d']).toEqual({ unit: 'day', buckets: 30 })
  })
})
