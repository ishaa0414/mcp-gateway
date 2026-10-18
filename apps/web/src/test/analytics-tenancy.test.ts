/** Tenant scoping: user B can read nothing of user A's analytics, through any entry point. */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { db } from '@mcp-gateway/db'
import {
  getSummary, getCallsOverTime, getTopTools, getRecentCalls, getCallDetail, getOverview, hasAnyLogs,
} from '@/lib/analytics/queries'
import { createOwner, deleteOwners, insertLogs, NOW } from './analytics-fixtures'

const opts = { range: '7d', timeZone: 'Asia/Kolkata', now: NOW } as const
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3600_000)

let a: Awaited<ReturnType<typeof createOwner>>
let b: typeof a
/** B asking for A's project: B's user id, A's slug. */
let bAsksForA: { userId: string; slug: string }

beforeAll(async () => {
  ;[a, b] = await Promise.all([createOwner('ten-a'), createOwner('ten-b')])
  bAsksForA = { userId: b.userId, slug: a.slug }
  await insertLogs(a.projectId, [
    { id: 'a-secret-1', at: hoursAgo(1), latency: 100, input: { petId: 1 } },
    { id: 'a-secret-2', at: hoursAgo(2), latency: 300 },
  ])
  await insertLogs(b.projectId, [{ id: 'b-own-1', at: hoursAgo(1), latency: 9 }])
})

afterAll(async () => {
  await deleteOwners(a.userId, b.userId)
  await db.$disconnect()
})

describe("user B cannot read user A's analytics", () => {
  it('every query returns null for A\'s slug', async () => {
    expect(await getSummary(bAsksForA, opts)).toBeNull()
    expect(await getCallsOverTime(bAsksForA, opts)).toBeNull()
    expect(await getTopTools(bAsksForA, opts)).toBeNull()
    expect(await getRecentCalls(bAsksForA, opts)).toBeNull()
    expect(await getOverview(bAsksForA, opts)).toBeNull()
    expect(await hasAnyLogs(bAsksForA)).toBeNull()
  })

  it("a log id of A's is not found through B's own project, nor through A's slug", async () => {
    expect(await getCallDetail(b.scope, 'a-secret-1')).toBeNull()
    expect(await getCallDetail(bAsksForA, 'a-secret-1')).toBeNull()
  })

  it("B's own project shows only B's rows", async () => {
    const summary = await getSummary(b.scope, opts)
    expect(summary).toMatchObject({ totalCalls: 1, p50Ms: 9 })
    const recent = await getRecentCalls(b.scope, opts)
    expect(recent!.calls.map((c) => c.id)).toEqual(['b-own-1'])
    expect((await getCallDetail(b.scope, 'b-own-1'))!.id).toBe('b-own-1')
  })

  it('an unknown slug looks exactly like someone else\'s', async () => {
    const nobody = { userId: a.userId, slug: 'no-such-project' }
    expect(await getSummary(nobody, opts)).toBeNull()
    expect(await getRecentCalls(nobody, opts)).toBeNull()
  })

  it('the owner gets their data', async () => {
    expect(await getSummary(a.scope, opts)).toMatchObject({ totalCalls: 2 })
    expect((await getRecentCalls(a.scope, opts))!.calls).toHaveLength(2)
    expect(await getCallDetail(a.scope, 'a-secret-1')).toMatchObject({ input: { petId: 1 } })
  })
})
