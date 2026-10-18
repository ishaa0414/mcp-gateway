/** Summary numbers, zero-filled series, top tools and the whole-tab overview, on known data. */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { db } from '@mcp-gateway/db'
import * as queries from '@/lib/analytics/queries'
import { getSummary, getCallsOverTime, getTopTools, getOverview, getRecentCalls } from '@/lib/analytics/queries'
import { createOwner, deleteOwners, insertLogs, NOW, TEST_DB_SESSION_TIME_ZONE } from './analytics-fixtures'

const opts = (range: '24h' | '7d' | '30d' = '7d', timeZone = 'Asia/Kolkata') => ({ range, timeZone, now: NOW })
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3600_000)

let empty: Awaited<ReturnType<typeof createOwner>>
let one: typeof empty
let known: typeof empty
let owners: string[]

beforeAll(async () => {
  ;[empty, one, known] = await Promise.all([createOwner('empty'), createOwner('one'), createOwner('known')])
  owners = [empty.userId, one.userId, known.userId]

  await insertLogs(one.projectId, [{ id: 'q-one-1', at: hoursAgo(1), latency: 250 }])

  await insertLogs(known.projectId, [
    // Five calls with latencies 10, 20, 30, 40, 100: p50 is 30, p95 is 88 (40 + 0.8 * 60).
    { id: 'q-k1', at: hoursAgo(1), tool: 'listPets', latency: 10 },
    { id: 'q-k2', at: hoursAgo(2), tool: 'listPets', latency: 20 },
    { id: 'q-k3', at: hoursAgo(3), tool: 'listPets', latency: 30, ok: false, errorClass: 'UPSTREAM_5XX' },
    { id: 'q-k4', at: hoursAgo(4), tool: 'addPet', latency: 40 },
    { id: 'q-k5', at: hoursAgo(5), tool: 'addPet', latency: 100, ok: false, errorClass: 'TIMEOUT', upstreamStatus: null },
    // Not calls: sampled, latency 0. They only feed the "at least" counts.
    { id: 'q-rl1', at: hoursAgo(1), tool: 'addPet', latency: 0, ok: false, errorClass: 'RATE_LIMITED', upstreamStatus: null },
    { id: 'q-rl2', at: hoursAgo(2), tool: 'addPet', latency: 0, ok: false, errorClass: 'RATE_LIMITED', upstreamStatus: null },
    { id: 'q-au1', at: hoursAgo(1), tool: null, kind: 'AUTH_FAILURE', latency: 0, ok: false, errorClass: 'AUTH_INVALID', upstreamStatus: null },
    // Outside 24 h but inside 7 d and 30 d.
    { id: 'q-old1', at: hoursAgo(24 * 3 + 2), tool: 'listPets', latency: 1000 },
    // Outside 7 d but inside 30 d.
    { id: 'q-old2', at: hoursAgo(24 * 20), tool: 'getPet', latency: 2000 },
  ])
})

afterAll(async () => {
  await deleteOwners(...owners)
  await db.$disconnect()
})

describe('summary percentiles', () => {
  it('empty window: zeros, no rate, no percentiles', async () => {
    const s = await getSummary(empty.scope, opts())
    expect(s).toMatchObject({ totalCalls: 0, errorCalls: 0, errorRate: null, p50Ms: null, p95Ms: null, authFailuresAtLeast: 0, rateLimitedAtLeast: 0 })
  })

  it('one row: p50 and p95 are that row', async () => {
    const s = await getSummary(one.scope, opts())
    expect(s).toMatchObject({ totalCalls: 1, errorRate: 0, p50Ms: 250, p95Ms: 250 })
  })

  it('known data: interpolated percentiles; rate-limited and auth rows stay out of the headline', async () => {
    const s = (await getSummary(known.scope, opts('24h')))!
    expect(s.totalCalls).toBe(5)
    expect(s.errorCalls).toBe(2)
    expect(s.errorRate).toBeCloseTo(0.4)
    expect(s.p50Ms).toBe(30)
    expect(s.p95Ms).toBeCloseTo(88)
    expect(s.rateLimitedAtLeast).toBe(2)
    expect(s.authFailuresAtLeast).toBe(1)
  })

  it('interpolates between two values (p50 of 100 and 200 is 150)', async () => {
    const two = await createOwner('two')
    owners.push(two.userId)
    await insertLogs(two.projectId, [
      { id: 'q-two-1', at: hoursAgo(1), latency: 100 },
      { id: 'q-two-2', at: hoursAgo(2), latency: 200 },
    ])
    expect((await getSummary(two.scope, opts()))!.p50Ms).toBe(150)
  })

  it('the range decides what is counted', async () => {
    expect((await getSummary(known.scope, opts('24h')))!.totalCalls).toBe(5)
    expect((await getSummary(known.scope, opts('7d')))!.totalCalls).toBe(6)
    expect((await getSummary(known.scope, opts('30d')))!.totalCalls).toBe(7)
  })

  it('reports the zone it used, and falls back to UTC for one Postgres does not know', async () => {
    expect(await getSummary(known.scope, opts('7d', 'Asia/Kolkata'))).toMatchObject({ timeZone: 'Asia/Kolkata', timeZoneFallback: false })
    expect(await getSummary(known.scope, opts('7d', 'Mars/Olympus'))).toMatchObject({ timeZone: 'UTC', timeZoneFallback: true })
  })
})

describe('calls over time', () => {
  it('24 h: 24 hourly buckets in IST, empty ones are zero rows', async () => {
    const series = (await getCallsOverTime(known.scope, opts('24h')))!
    expect(series).toHaveLength(24)
    // 10:00 UTC is 15:30 IST, so the current bucket starts at 15:00 IST = 09:30 UTC.
    expect(series[23]!.start.toISOString()).toBe('2026-10-12T09:30:00.000Z')
    expect(series[0]!.start.toISOString()).toBe('2026-10-11T10:30:00.000Z')
    for (let i = 1; i < 24; i++) expect(series[i]!.start.getTime() - series[i - 1]!.start.getTime()).toBe(3600_000)
    expect(series.filter((b) => b.ok + b.errors === 0).length).toBeGreaterThan(15)
    expect(series.reduce((n, b) => n + b.ok + b.errors, 0)).toBe(5)
    expect(series.reduce((n, b) => n + b.errors, 0)).toBe(2)
  })

  it('7 d and 30 d: daily buckets that add up to the summary', async () => {
    for (const [range, n] of [['7d', 7], ['30d', 30]] as const) {
      const series = (await getCallsOverTime(known.scope, opts(range)))!
      const summary = (await getSummary(known.scope, opts(range)))!
      expect(series).toHaveLength(n)
      expect(series.reduce((t, b) => t + b.ok + b.errors, 0)).toBe(summary.totalCalls)
      expect(series.reduce((t, b) => t + b.errors, 0)).toBe(summary.errorCalls)
    }
  })

  it('a project with no calls still gets a full grid of zeros', async () => {
    const series = (await getCallsOverTime(empty.scope, opts('7d')))!
    expect(series).toHaveLength(7)
    expect(series.every((b) => b.ok === 0 && b.errors === 0)).toBe(true)
  })
})

describe('top tools', () => {
  it('per tool: calls, error rate and percentiles, busiest first, rate-limited rows excluded', async () => {
    const tools = (await getTopTools(known.scope, opts('24h')))!
    expect(tools).toHaveLength(2) // the auth failure has no tool and the rate-limited rows are not calls
    expect(tools[0]).toMatchObject({ toolName: 'listPets', calls: 3, errorCalls: 1, p50Ms: 20 })
    expect(tools[0]!.errorRate).toBeCloseTo(1 / 3)
    expect(tools[1]).toMatchObject({ toolName: 'addPet', calls: 2, errorCalls: 1, errorRate: 0.5, p50Ms: 70 })
    expect(tools[1]!.p95Ms).toBeCloseTo(97)
  })

  it('is empty for a project without calls', async () => {
    expect(await getTopTools(empty.scope, opts())).toEqual([])
  })

  it('limits the list to 10 tools', async () => {
    const many = await createOwner('many')
    owners.push(many.userId)
    await insertLogs(many.projectId, Array.from({ length: 14 }, (_, i) => ({ id: `q-m${i}`, at: hoursAgo(1), tool: `tool${i}` })))
    expect(await getTopTools(many.scope, opts())).toHaveLength(10)
  })
})

describe('overview', () => {
  it('bundles the pieces and says whether the project has ever logged anything', async () => {
    const o = (await getOverview(known.scope, opts('24h')))!
    expect(o.summary.totalCalls).toBe(5)
    expect(o.series).toHaveLength(24)
    expect(o.topTools).toHaveLength(2)
    expect(o.hasAnyLogs).toBe(true)
    expect((await getOverview(empty.scope, opts()))!.hasAnyLogs).toBe(false)
  })

  it('a quiet range is not the empty state: logs exist, just none in the window', async () => {
    const quiet = await createOwner('quiet')
    owners.push(quiet.userId)
    await insertLogs(quiet.projectId, [{ id: 'q-q1', at: hoursAgo(24 * 10) }])
    const o = (await getOverview(quiet.scope, opts('24h')))!
    expect(o.summary.totalCalls).toBe(0)
    expect(o.hasAnyLogs).toBe(true)
  })
})

describe('window bounds are exact, whatever the database session time zone is', () => {
  // 7 d in IST at NOW: the window starts at IST midnight 6 days back, 2026-10-05T18:30:00Z, and ends at NOW.
  const LO = '2026-10-05T18:30:00.000Z'
  let edge: Awaited<ReturnType<typeof createOwner>>

  beforeAll(async () => {
    edge = await createOwner('edge')
    owners.push(edge.userId)
    await insertLogs(edge.projectId, [
      { id: 'q-edge-lo-minus', at: '2026-10-05T18:29:59.999Z' },
      { id: 'q-edge-lo', at: LO },
      { id: 'q-edge-now-minus', at: new Date(NOW.getTime() - 60_000) },
      { id: 'q-edge-now', at: NOW },
      { id: 'q-edge-now-plus', at: new Date(NOW.getTime() + 1) },
    ])
  })

  it('the database session really is not UTC (otherwise this block proves nothing)', async () => {
    const [row] = await db.$queryRaw<{ TimeZone: string }[]>`SHOW TimeZone`
    expect(row!.TimeZone).toBe(TEST_DB_SESSION_TIME_ZONE)
  })

  it('counts a row at the window start and at now, and not 1 ms before the start or 1 ms after now', async () => {
    const s = (await getSummary(edge.scope, opts('7d')))!
    expect(s.windowStart.toISOString()).toBe(LO)
    expect(s.windowEnd.toISOString()).toBe(NOW.toISOString())
    expect(s.totalCalls).toBe(3) // lo, now-1min, now
    const series = (await getCallsOverTime(edge.scope, opts('7d')))!
    expect(series[0]!.start.toISOString()).toBe(LO)
    expect(series.reduce((n, b) => n + b.ok + b.errors, 0)).toBe(3)
    expect((await getTopTools(edge.scope, opts('7d')))![0]!.calls).toBe(3)
  })

  it('recent calls use the same window: same rows as the cards', async () => {
    const page = (await getRecentCalls(edge.scope, opts('7d')))!
    expect(page.calls.map((c) => c.id)).toEqual(['q-edge-now', 'q-edge-now-minus', 'q-edge-lo'])
  })
})

describe('recent calls follow the range picker', () => {
  let r: Awaited<ReturnType<typeof createOwner>>

  beforeAll(async () => {
    r = await createOwner('range')
    owners.push(r.userId)
    await insertLogs(r.projectId, [
      { id: 'q-r-2h', at: hoursAgo(2) },
      { id: 'q-r-3d', at: hoursAgo(24 * 3) },
      { id: 'q-r-20d', at: hoursAgo(24 * 20) },
      { id: 'q-r-auth', at: hoursAgo(1), tool: null, kind: 'AUTH_FAILURE', ok: false, errorClass: 'AUTH_INVALID', latency: 0, upstreamStatus: null },
    ])
  })

  it.each([
    ['24h', ['q-r-auth', 'q-r-2h']],
    ['7d', ['q-r-auth', 'q-r-2h', 'q-r-3d']],
    ['30d', ['q-r-auth', 'q-r-2h', 'q-r-3d', 'q-r-20d']],
  ] as const)('%s lists exactly the rows in that window', async (range, ids) => {
    const page = (await getRecentCalls(r.scope, opts(range)))!
    expect(page.calls.map((c) => c.id)).toEqual(ids)
    expect(page.nextCursor).toBeNull()
  })

  it('a quiet range gives an empty page, not "not found"', async () => {
    const quiet = await createOwner('range-quiet')
    owners.push(quiet.userId)
    await insertLogs(quiet.projectId, [{ id: 'q-rq-old', at: hoursAgo(24 * 10) }])
    expect(await getRecentCalls(quiet.scope, opts('24h'))).toEqual({ calls: [], nextCursor: null })
  })
})

describe('the module exposes only scoped entry points', () => {
  it('every exported function takes the { userId, slug } scope first; none takes a raw project id', () => {
    const functions = Object.entries(queries).filter(([, v]) => typeof v === 'function' && !/^[A-Z]/.test(v.name))
    expect(functions.map(([name]) => name).sort()).toEqual([
      'getCallDetail', 'getCallsOverTime', 'getOverview', 'getRecentCalls', 'getSummary', 'getTopTools', 'hasAnyLogs',
    ])
  })
})
