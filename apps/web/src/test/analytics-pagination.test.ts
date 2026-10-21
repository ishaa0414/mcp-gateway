/** Recent calls: keyset pagination, ties inside one millisecond, row kinds, and call detail. */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { db } from '@mcp-gateway/db'
import { getRecentCalls, getCallDetail, InvalidCursorError } from '@/lib/analytics/queries'
import { encodeCursor } from '@/lib/analytics/cursor'
import { createOwner, deleteOwners, insertLogs, NOW, type LogSpec } from './analytics-fixtures'

/** Every row is inside the window; `now` is just after the newest (rate-limited/auth) rows. */
const win = { range: '7d' as const, timeZone: 'Asia/Kolkata', now: new Date(NOW.getTime() + 10_000) }

let a: Awaited<ReturnType<typeof createOwner>>
let b: typeof a
let expectedOrder: string[]

beforeAll(async () => {
  ;[a, b] = await Promise.all([createOwner('pg-a'), createOwner('pg-b')])

  const specs: LogSpec[] = []
  // 30 rows, one per minute.
  for (let i = 0; i < 30; i++) specs.push({ id: `pg-r${String(i).padStart(3, '0')}`, at: new Date(NOW.getTime() - i * 60_000) })
  // 9 rows in exactly the same millisecond: only the id can order them.
  const tie = new Date(NOW.getTime() - 45 * 60_000 + 123)
  for (const c of 'abcdefghi') specs.push({ id: `pg-tie-${c}`, at: tie })
  // An auth failure (no tool) and a rate-limited call, the newest rows of all.
  specs.push({ id: 'pg-auth1', at: new Date(NOW.getTime() + 2000), tool: null, kind: 'AUTH_FAILURE', ok: false, errorClass: 'AUTH_INVALID', latency: 0, upstreamStatus: null })
  specs.push({ id: 'pg-rl1', at: new Date(NOW.getTime() + 1000), ok: false, errorClass: 'RATE_LIMITED', latency: 0, upstreamStatus: null })
  await insertLogs(a.projectId, specs)
  await insertLogs(b.projectId, [{ id: 'b-only', at: NOW }])

  expectedOrder = [...specs]
    .sort((x, y) => new Date(y.at).getTime() - new Date(x.at).getTime() || (x.id < y.id ? 1 : -1))
    .map((s) => s.id)
})

afterAll(async () => {
  await deleteOwners(a.userId, b.userId)
  await db.$disconnect()
})

async function walk(limit: number) {
  const ids: string[] = []
  let cursor: string | null = null
  let pages = 0
  do {
    const page: Awaited<ReturnType<typeof getRecentCalls>> = await getRecentCalls(a.scope, { ...win, cursor, limit })
    ids.push(...page!.calls.map((c) => c.id))
    cursor = page!.nextCursor
    pages++
  } while (cursor && pages < 100)
  return { ids, pages }
}

describe('recent calls pagination', () => {
  it('walks every row exactly once, newest first, with no gaps or repeats', async () => {
    const { ids, pages } = await walk(7)
    expect(ids).toEqual(expectedOrder)
    expect(new Set(ids).size).toBe(ids.length)
    expect(pages).toBe(Math.ceil(expectedOrder.length / 7))
  })

  // Real work: 41 rows walked at five page sizes is about 80 sequential page queries (each also resolves the owned
  // project). 0.64 s idle, 5.2 s with the CPU starved, so it gets its own limit instead of the 5 s default.
  it('does not split or repeat rows that share one millisecond, whatever the page size', { timeout: 30_000 }, async () => {
    for (const limit of [1, 2, 4, 9, 10]) {
      expect((await walk(limit)).ids).toEqual(expectedOrder)
    }
  })

  it('the last page has no cursor, and an exactly-full last page does not invent one', async () => {
    const total = expectedOrder.length
    const exact = await getRecentCalls(a.scope, { ...win, limit: total })
    expect(exact!.calls).toHaveLength(total)
    expect(exact!.nextCursor).toBeNull()
    const almost = await getRecentCalls(a.scope, { ...win, limit: total - 1 })
    expect(almost!.nextCursor).not.toBeNull()
  })

  it('defaults to 25 rows and caps the page size at 100', async () => {
    expect((await getRecentCalls(a.scope, win))!.calls).toHaveLength(25)
    expect((await getRecentCalls(a.scope, { ...win, limit: 100000 }))!.calls.length).toBeLessThanOrEqual(100)
  })

  it('lists auth failures (no tool name) and rate-limited calls next to ordinary ones', async () => {
    const calls = (await getRecentCalls(a.scope, { ...win, limit: 3 }))!.calls
    expect(calls[0]).toMatchObject({ id: 'pg-auth1', kind: 'AUTH_FAILURE', toolName: null, errorClass: 'AUTH_INVALID', success: false, upstreamStatus: null })
    expect(calls[1]).toMatchObject({ id: 'pg-rl1', kind: 'TOOL_CALL', toolName: 'listPets', errorClass: 'RATE_LIMITED', latencyMs: 0 })
    expect(calls[2]).toMatchObject({ kind: 'TOOL_CALL', success: true, upstreamStatus: 200 })
  })

  it('a project with no logs gives an empty page, not "not found"', async () => {
    const none = await createOwner('pg-none')
    try {
      expect(await getRecentCalls(none.scope, win)).toEqual({ calls: [], nextCursor: null })
    } finally {
      await deleteOwners(none.userId)
    }
  })

  it('rejects cursors that are not ours', async () => {
    const bad = ['garbage', '!!!', 'AAAA', Buffer.from('no-separator').toString('base64url'), 'x'.repeat(500)]
    bad.push(encodeCursor({ createdAt: '2026-02-31T00:00:00.000000', id: 'x' }))
    bad.push(encodeCursor({ createdAt: "2026-01-01T00:00:00.000000'; DROP TABLE tool_call_logs;--", id: 'x' }))
    for (const cursor of bad) {
      await expect(getRecentCalls(a.scope, { ...win, cursor })).rejects.toBeInstanceOf(InvalidCursorError)
    }
  })

  it("a cursor taken from another project cannot reveal that project's rows", async () => {
    const first = await getRecentCalls(a.scope, { ...win, limit: 5 })
    const theirs = await getRecentCalls(b.scope, { ...win, cursor: first!.nextCursor })
    expect(theirs!.calls.map((c) => c.id)).toEqual([]) // b-only is newer than the cursor position
    const all = await getRecentCalls(b.scope, win)
    expect(all!.calls.map((c) => c.id)).toEqual(['b-only'])
  })
})

describe('call detail', () => {
  it('returns the stored masked input and nothing the row does not hold', async () => {
    await insertLogs(a.projectId, [
      { id: 'pg-detail1', at: NOW, input: { petId: 7, api_key: '[MASKED]' }, ok: false, errorClass: 'UPSTREAM_4XX', upstreamStatus: 404 },
    ])
    const d = await getCallDetail(a.scope, 'pg-detail1')
    expect(d).toMatchObject({ id: 'pg-detail1', input: { petId: 7, api_key: '[MASKED]' }, errorClass: 'UPSTREAM_4XX', upstreamStatus: 404 })
    expect(Object.keys(d!).sort()).toEqual(
      ['createdAt', 'errorClass', 'errorMessage', 'id', 'input', 'kind', 'latencyMs', 'responseBytes', 'success', 'toolName', 'upstreamStatus'].sort()
    )
  })

  it('an unknown id is null', async () => {
    expect(await getCallDetail(a.scope, 'nope')).toBeNull()
  })
})
