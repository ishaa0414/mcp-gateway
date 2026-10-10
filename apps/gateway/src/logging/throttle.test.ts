import { describe, expect, it } from 'vitest'
import { SampleThrottle } from './throttle.js'

describe('SampleThrottle', () => {
  it('lets one event per key through per interval, and counts the rest', () => {
    let now = 0
    const t = new SampleThrottle(10_000, 100, 1_000, () => now)

    expect(t.allow('a')).toBe(true)
    for (let i = 0; i < 50; i++) expect(t.allow('a')).toBe(false)
    expect(t.suppressed).toBe(50)

    now = 9_999
    expect(t.allow('a')).toBe(false)
    now = 10_000
    expect(t.allow('a')).toBe(true)
  })

  it('treats keys independently', () => {
    const t = new SampleThrottle(10_000, 100, 1_000, () => 0)
    expect(t.allow('a')).toBe(true)
    expect(t.allow('b')).toBe(true)
    expect(t.allow('a')).toBe(false)
  })

  it('caps the total per interval across keys', () => {
    let now = 0
    const t = new SampleThrottle(10_000, 1_000, 3, () => now)
    expect(['a', 'b', 'c', 'd', 'e'].map((k) => t.allow(k))).toEqual([true, true, true, false, false])

    now = 10_000
    expect(t.allow('d')).toBe(true)
  })

  it('remembers a bounded number of keys', () => {
    const t = new SampleThrottle(10_000, 3, 1_000, () => 0)
    for (const k of ['a', 'b', 'c', 'd']) t.allow(k) // 'a' is forgotten
    expect(t.allow('d')).toBe(false)
    expect(t.allow('a')).toBe(true) // forgotten, so allowed again
  })
})
