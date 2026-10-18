'use server'
import { auth } from '@/auth'
import { cookies } from 'next/headers'
import { z } from 'zod'
import { getCallDetail, getRecentCalls, InvalidCursorError } from '@/lib/analytics/queries'
import { toRow, type RecentCallRow } from '@/lib/analytics/rows'
import { RANGES } from '@/lib/analytics/range'
import { VIEWER_TZ_COOKIE } from '@/lib/analytics/viewer-tz'

/**
 * Server actions for the Analytics tab. Each one calls `auth()` first, validates its input with
 * Zod, and passes the signed-in user's id to the query layer, which scopes every row to a project
 * that user owns. Results are plain values so the client can tell the cases apart.
 */
export type ActionResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: 'unauthenticated' | 'not_found' | 'invalid' }

const Slug = z.string().regex(/^[a-z0-9-]{3,48}$/)
const TimeZoneName = z.string().min(1).max(64)

async function signedInUserId(): Promise<string | null> {
  const session = await auth()
  return session?.user?.id ?? null
}

// ---------------------------------------------------------------------------------------------

/**
 * Remember the browser's time zone for the next render. Any string is stored: the page checks it
 * against the zones Postgres knows and shows "Showing UTC" for one it does not, so a junk value
 * ends the first-visit round trip instead of repeating it.
 */
export async function setViewerTimeZone(timeZone: string): Promise<ActionResult<null>> {
  if (!(await signedInUserId())) return { ok: false, error: 'unauthenticated' }
  const parsed = TimeZoneName.safeParse(timeZone)
  if (!parsed.success) return { ok: false, error: 'invalid' }
  ;(await cookies()).set(VIEWER_TZ_COOKIE, parsed.data, {
    path: '/',
    maxAge: 60 * 60 * 24 * 365,
    sameSite: 'lax',
    httpOnly: false,
  })
  return { ok: true, data: null }
}

// ---------------------------------------------------------------------------------------------

const LoadMoreInput = z.object({
  slug: Slug,
  range: z.enum(RANGES),
  timeZone: TimeZoneName,
  /** The first page's windowEnd: keeps the window where it was while paging. */
  now: z.iso.datetime(),
  cursor: z.string().min(1).max(200),
})

export interface RecentCallsResult {
  calls: RecentCallRow[]
  nextCursor: string | null
}

export async function loadMoreCalls(input: z.input<typeof LoadMoreInput>): Promise<ActionResult<RecentCallsResult>> {
  const userId = await signedInUserId()
  if (!userId) return { ok: false, error: 'unauthenticated' }
  const parsed = LoadMoreInput.safeParse(input)
  if (!parsed.success) return { ok: false, error: 'invalid' }
  const { slug, range, timeZone, now, cursor } = parsed.data

  try {
    const page = await getRecentCalls({ userId, slug }, { range, timeZone, now: new Date(now), cursor })
    if (!page) return { ok: false, error: 'not_found' }
    return { ok: true, data: { calls: page.calls.map(toRow), nextCursor: page.nextCursor } }
  } catch (err) {
    if (err instanceof InvalidCursorError) return { ok: false, error: 'invalid' }
    throw err
  }
}

// ---------------------------------------------------------------------------------------------

const DetailInput = z.object({ slug: Slug, id: z.string().min(1).max(64) })

/** What the dialog shows, and nothing else from the row. */
export interface CallDetailView {
  /** The masked, truncated arguments exactly as stored. */
  input: unknown
  errorMessage: string | null
  responseBytes: number | null
}

export async function loadCallDetail(input: z.input<typeof DetailInput>): Promise<ActionResult<CallDetailView>> {
  const userId = await signedInUserId()
  if (!userId) return { ok: false, error: 'unauthenticated' }
  const parsed = DetailInput.safeParse(input)
  if (!parsed.success) return { ok: false, error: 'invalid' }

  const detail = await getCallDetail({ userId, slug: parsed.data.slug }, parsed.data.id)
  if (!detail) return { ok: false, error: 'not_found' }
  return { ok: true, data: { input: detail.input, errorMessage: detail.errorMessage, responseBytes: detail.responseBytes } }
}
