/** Time-zone handling: validation, IST midnight, Calcutta vs Kolkata, and a clock change. */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { db } from '@mcp-gateway/db'
import { getCallsOverTime, getSummary } from '@/lib/analytics/queries'
import { resolveTimeZone } from '@/lib/analytics/timezone'
import { createOwner, deleteOwners, insertLogs, NOW } from './analytics-fixtures'

let owner: Awaited<ReturnType<typeof createOwner>>

beforeAll(async () => {
  owner = await createOwner('tz')
  await insertLogs(owner.projectId, [
    // 23:59:59 and 00:00:00 IST around midnight between 10 and 11 October: the same UTC day.
    { id: 'before-midnight-ist', at: '2026-10-10T18:29:59.000Z' },
    { id: 'after-midnight-ist', at: '2026-10-10T18:30:00.000Z', ok: false },
    // New York around the March 2026 clock change (8 March, 02:00 -> 03:00).
    { id: 'ny-last-minute-of-8th', at: '2026-03-09T03:59:00.000Z' },
    { id: 'ny-first-minute-of-9th', at: '2026-03-09T04:00:00.000Z' },
  ])
})

afterAll(async () => {
  await deleteOwners(owner.userId)
  await db.$disconnect()
})

const iso = (d: Date) => d.toISOString()
const counts = (series: { ok: number; errors: number }[]) => series.map((b) => b.ok + b.errors)

describe('resolveTimeZone', () => {
  it.each(['Asia/Kolkata', 'Asia/Calcutta', 'UTC', 'Etc/GMT+5', 'America/Argentina/Buenos_Aires', 'America/New_York'])(
    'accepts %s',
    async (name) => {
      expect(await resolveTimeZone(name)).toEqual({ timeZone: name, fallback: false })
    }
  )

  it.each([
    'Mars/Olympus',
    '',
    'asia kolkata',
    "UTC'; DROP TABLE tool_call_logs;--",
    'Asia/Kolkata\n',
    '../../etc/passwd',
    'A'.repeat(65),
    '+05:30 hours',
  ])('falls back to UTC for %j', async (name) => {
    expect(await resolveTimeZone(name)).toEqual({ timeZone: 'UTC', fallback: true })
  })

  it('falls back to UTC for non-strings', async () => {
    for (const v of [undefined, null, 5, {}, ['UTC']]) expect(await resolveTimeZone(v)).toEqual({ timeZone: 'UTC', fallback: true })
  })
})

describe('midnight in IST', () => {
  const at = (timeZone: string) => ({ range: '7d' as const, timeZone, now: NOW })

  it('puts 23:59:59 and 00:00:00 IST in different days', async () => {
    const series = (await getCallsOverTime(owner.scope, at('Asia/Kolkata')))!
    const day = (startIso: string) => series.find((b) => iso(b.start) === startIso)!
    // IST days start at 18:30 UTC the evening before.
    expect(day('2026-10-09T18:30:00.000Z')).toMatchObject({ ok: 1, errors: 0 }) // 10 Oct IST
    expect(day('2026-10-10T18:30:00.000Z')).toMatchObject({ ok: 0, errors: 1 }) // 11 Oct IST
    expect(counts(series).reduce((a, b) => a + b, 0)).toBe(2)
  })

  it('the same two calls are one UTC day', async () => {
    const series = (await getCallsOverTime(owner.scope, at('UTC')))!
    expect(series.find((b) => iso(b.start) === '2026-10-10T00:00:00.000Z')).toMatchObject({ ok: 1, errors: 1 })
  })

  it('Asia/Calcutta (what Chrome on Windows reports) buckets exactly like Asia/Kolkata', async () => {
    const kolkata = await getCallsOverTime(owner.scope, at('Asia/Kolkata'))
    const calcutta = await getCallsOverTime(owner.scope, at('Asia/Calcutta'))
    expect(calcutta).toEqual(kolkata)
    expect(await getSummary(owner.scope, at('Asia/Calcutta'))).toMatchObject({ timeZone: 'Asia/Calcutta', timeZoneFallback: false })
  })

  it('24 h buckets in IST start on the half hour', async () => {
    const series = (await getCallsOverTime(owner.scope, { range: '24h', timeZone: 'Asia/Kolkata', now: NOW }))!
    expect(series.every((b) => b.start.getUTCMinutes() === 30)).toBe(true)
  })

  it('a zone Postgres does not know falls back to UTC buckets', async () => {
    const bad = await getCallsOverTime(owner.scope, at('Mars/Olympus'))
    expect(bad).toEqual(await getCallsOverTime(owner.scope, at('UTC')))
  })

  it('Etc/GMT+5 is five hours behind UTC (the sign is POSIX-style)', async () => {
    const series = (await getCallsOverTime(owner.scope, at('Etc/GMT+5')))!
    expect(series.every((b) => b.start.getUTCHours() === 5)).toBe(true)
  })
})

describe('across a clock change', () => {
  it('New York: the 8 March day is 23 hours long and calls land on the right side of midnight', async () => {
    const now = new Date('2026-03-10T12:00:00.000Z')
    const series = (await getCallsOverTime(owner.scope, { range: '7d', timeZone: 'America/New_York', now }))!
    expect(series.map((b) => iso(b.start))).toEqual([
      '2026-03-04T05:00:00.000Z',
      '2026-03-05T05:00:00.000Z',
      '2026-03-06T05:00:00.000Z',
      '2026-03-07T05:00:00.000Z',
      '2026-03-08T05:00:00.000Z', // 8 March: EST, 23 hours until the next start
      '2026-03-09T04:00:00.000Z', // 9 March: EDT
      '2026-03-10T04:00:00.000Z',
    ])
    expect(counts(series)).toEqual([0, 0, 0, 0, 1, 1, 0])
  })
})
