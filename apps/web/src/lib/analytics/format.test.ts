import { describe, expect, it } from 'vitest'
import { formatAtLeast, formatBucketLabel, formatBucketTitle, formatBytes, formatInstant, formatMs, formatPercent, niceMax, NO_VALUE } from './format'

describe('formatInstant', () => {
  it('states the instant in the viewer zone, with the zone name', () => {
    // 2026-10-05 18:30 UTC is 6 Oct 00:00 in India.
    expect(formatInstant(new Date('2026-10-05T18:30:00Z'), 'Asia/Kolkata')).toMatch(/^6 Oct, 00:00 (IST|GMT\+5:30)$/)
    expect(formatInstant(new Date('2026-10-05T18:30:00Z'), 'UTC')).toBe('5 Oct, 18:30 UTC')
  })

  it('falls back to UTC for a zone ICU does not know', () => {
    expect(formatInstant(new Date('2026-10-05T18:30:00Z'), 'Not/AZone')).toBe('5 Oct, 18:30 UTC')
  })

  it('shows midnight as 00:00, not 24:00', () => {
    expect(formatInstant(new Date('2026-10-06T00:00:00Z'), 'UTC')).toBe('6 Oct, 00:00 UTC')
  })
})

describe('bucket labels', () => {
  const start = new Date('2026-10-05T18:30:00Z')
  it('hourly buckets show the local time, daily buckets the local date', () => {
    expect(formatBucketLabel(start, 'Asia/Kolkata', 'hour')).toBe('00:00')
    expect(formatBucketLabel(start, 'Asia/Kolkata', 'day')).toBe('6 Oct')
    expect(formatBucketTitle(start, 'Asia/Kolkata', 'day')).toBe('Tue 6 Oct')
    expect(formatBucketTitle(start, 'Asia/Kolkata', 'hour')).toBe('6 Oct, 00:00')
  })
})

describe('number formatting', () => {
  it('shows null as a dash', () => {
    expect(formatMs(null)).toBe(NO_VALUE)
    expect(formatPercent(null)).toBe(NO_VALUE)
    expect(formatBytes(null)).toBe(NO_VALUE)
  })

  it('formats latency, rates and sizes', () => {
    expect(formatMs(149.6)).toBe('150 ms')
    expect(formatMs(1500)).toBe('1.50 s')
    expect(formatPercent(0)).toBe('0%')
    expect(formatPercent(0.0345)).toBe('3.5%')
    expect(formatPercent(0.5)).toBe('50%')
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(2048)).toBe('2.0 KB')
  })
})

describe('formatAtLeast', () => {
  it('says "at least" only for a positive count', () => {
    expect(formatAtLeast(0)).toBe('0')
    expect(formatAtLeast(1)).toBe('at least 1')
    expect(formatAtLeast(1234)).toBe('at least 1,234')
  })
})

describe('niceMax', () => {
  it('rounds up to 1, 2 or 5 times a power of ten, never below 4', () => {
    expect(niceMax(0)).toBe(4)
    expect(niceMax(3)).toBe(4)
    expect(niceMax(5)).toBe(5)
    expect(niceMax(6)).toBe(10)
    expect(niceMax(11)).toBe(20)
    expect(niceMax(37)).toBe(50)
    expect(niceMax(51)).toBe(100)
    expect(niceMax(1234)).toBe(2000)
  })
})
