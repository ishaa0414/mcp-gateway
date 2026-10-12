/**
 * Analytics server actions against the test database. The session and the cookie jar are mocked;
 * validation, the ownership checks and the queries are real.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { db } from '@mcp-gateway/db'

const session = vi.hoisted(() => ({ userId: '' }))
const jar = vi.hoisted(() => ({ set: vi.fn() }))

vi.mock('@/auth', () => ({ auth: async () => (session.userId ? { user: { id: session.userId } } : null) }))
vi.mock('next/headers', () => ({ cookies: async () => jar }))

import { loadCallDetail, loadMoreCalls, setViewerTimeZone } from '@/actions/analytics'
import { createOwner, deleteOwners, insertLogs, NOW } from './analytics-fixtures'

let owner: Awaited<ReturnType<typeof createOwner>>
let other: typeof owner
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3600_000)

beforeAll(async () => {
  ;[owner, other] = await Promise.all([createOwner('act-owner'), createOwner('act-other')])
  const rows = Array.from({ length: 30 }, (_, i) => ({ id: `act-${owner.slug}-${i}`, at: hoursAgo(1 + i / 10) }))
  await insertLogs(owner.projectId, [...rows, { id: `act-detail-${owner.slug}`, at: hoursAgo(3), ok: false, input: { petId: 7 } }])
})

afterAll(async () => {
  await deleteOwners(owner.userId, other.userId)
  await db.$disconnect()
})

beforeEach(() => {
  session.userId = owner.userId
  jar.set.mockClear()
})

const input = (over: Record<string, unknown> = {}) => ({
  slug: owner.slug,
  range: '7d' as const,
  timeZone: 'Asia/Kolkata',
  now: NOW.toISOString(),
  cursor: 'x',
  ...over,
})

async function firstCursor(): Promise<string> {
  const { getRecentCalls } = await import('@/lib/analytics/queries')
  const page = await getRecentCalls(owner.scope, { range: '7d', timeZone: 'Asia/Kolkata', now: NOW, limit: 5 })
  return page!.nextCursor!
}

describe('unauthenticated', () => {
  it('every action is rejected before touching data', async () => {
    session.userId = ''
    const cursor = await (async () => {
      session.userId = owner.userId
      const c = await firstCursor()
      session.userId = ''
      return c
    })()
    expect(await setViewerTimeZone('Asia/Kolkata')).toEqual({ ok: false, error: 'unauthenticated' })
    expect(jar.set).not.toHaveBeenCalled()
    expect(await loadMoreCalls(input({ cursor }))).toEqual({ ok: false, error: 'unauthenticated' })
    expect(await loadCallDetail({ slug: owner.slug, id: `act-detail-${owner.slug}` })).toEqual({ ok: false, error: 'unauthenticated' })
  })
})

describe("another user's project", () => {
  it('gives not found, the same as an unknown slug', async () => {
    const cursor = await firstCursor()
    session.userId = other.userId
    expect(await loadMoreCalls(input({ cursor }))).toEqual({ ok: false, error: 'not_found' })
    expect(await loadMoreCalls(input({ cursor, slug: 'no-such-project' }))).toEqual({ ok: false, error: 'not_found' })
    expect(await loadCallDetail({ slug: owner.slug, id: `act-detail-${owner.slug}` })).toEqual({ ok: false, error: 'not_found' })
    // Their own project, someone else's row id.
    expect(await loadCallDetail({ slug: other.slug, id: `act-detail-${owner.slug}` })).toEqual({ ok: false, error: 'not_found' })
  })
})

describe('input validation', () => {
  it('rejects a cursor that is not one we issued', async () => {
    for (const cursor of ['not-a-cursor', 'AAAA', '!!', 'x'.repeat(201), '']) {
      expect(await loadMoreCalls(input({ cursor }))).toEqual({ ok: false, error: 'invalid' })
    }
  })

  it('rejects a bad range, time, slug or id', async () => {
    const cursor = await firstCursor()
    expect(await loadMoreCalls(input({ cursor, range: '90d' }))).toEqual({ ok: false, error: 'invalid' })
    expect(await loadMoreCalls(input({ cursor, now: 'yesterday' }))).toEqual({ ok: false, error: 'invalid' })
    expect(await loadMoreCalls(input({ cursor, slug: 'Bad Slug' }))).toEqual({ ok: false, error: 'invalid' })
    expect(await loadCallDetail({ slug: owner.slug, id: '' })).toEqual({ ok: false, error: 'invalid' })
    expect(await setViewerTimeZone('')).toEqual({ ok: false, error: 'invalid' })
    expect(await setViewerTimeZone('x'.repeat(65))).toEqual({ ok: false, error: 'invalid' })
  })
})

describe('happy paths', () => {
  it('pages through the same window the first page used', async () => {
    const cursor = await firstCursor()
    const res = await loadMoreCalls(input({ cursor }))
    expect(res.ok).toBe(true)
    if (res.ok) {
      expect(res.data.calls.length).toBeGreaterThan(0)
      expect(typeof res.data.calls[0]!.createdAt).toBe('string')
    }
  })

  it('returns only the input, error message and response size of a call', async () => {
    const res = await loadCallDetail({ slug: owner.slug, id: `act-detail-${owner.slug}` })
    expect(res).toEqual({ ok: true, data: { input: { petId: 7 }, errorMessage: null, responseBytes: null } })
  })

  it('stores the browser zone in the viewer_tz cookie', async () => {
    expect(await setViewerTimeZone('Asia/Kolkata')).toEqual({ ok: true, data: null })
    expect(jar.set).toHaveBeenCalledWith('viewer_tz', 'Asia/Kolkata', expect.objectContaining({ path: '/', sameSite: 'lax' }))
  })
})
