import 'server-only'
import { db, Prisma } from '@/lib/db'
import { RANGE_PLANS, type Range } from './range'
import { decodeCursor, encodeCursor, type Cursor } from './cursor'
import { resolveTimeZone } from './timezone'

/**
 * Analytics, computed from raw `tool_call_logs` (no rollup tables).
 *
 * Tenant scoping: every public function takes `{ userId, slug }` and starts by turning it into a
 * project id with `ownedProjectId` (`WHERE slug = $1 AND user_id = $2`). That is the only way a
 * project id enters this module, and every log query filters on it, so there is no way to ask for
 * a log row without naming its owner. A project the user does not own gives null.
 * The id is looked up first, instead of joining `projects` inside each statement, so the
 * planner sees the id as a parameter and can use the `(project_id, created_at)` index; with a
 * join it cannot know the project and, on a table shared by many tenants, reads other tenants' rows.
 *
 * `tool_call_logs.created_at` is `timestamp(3) WITHOUT time zone` holding UTC. It is compared
 * as-is (so the indexes apply) and only converted with `AT TIME ZONE 'UTC'` when it is bucketed.
 * Every instant that leaves SQL is also a UTC wall-clock `timestamp`, never a `timestamptz`: the
 * Prisma pg adapter relabels a timestamptz's offset as +00:00 without converting, which is only
 * right when the database session's TimeZone is UTC (see the time-zone note in DECISIONS.md).
 *
 * What counts as a call: a `TOOL_CALL` row that was not turned away by the rate limiter.
 * Rate-limited rows are sampled and have latency 0, so they would distort every number; they
 * and auth failures are reported separately as "at least" counts.
 */

export interface AnalyticsScope {
  userId: string
  slug: string
}

export interface WindowOptions {
  range: Range
  /** Whatever the browser reported; validated here against the zones Postgres knows. */
  timeZone: string
  /** Injectable clock for tests. */
  now?: Date
}

const COUNTED = Prisma.sql`(l.kind = 'TOOL_CALL' AND l.error_class IS DISTINCT FROM 'RATE_LIMITED')`

async function ownedProjectId(scope: AnalyticsScope): Promise<string | null> {
  const project = await db.project.findFirst({ where: { slug: scope.slug, userId: scope.userId }, select: { id: true } })
  return project?.id ?? null
}

/**
 * One row `win`: the bucket grid. `last_start` is the start of the current local hour or day,
 * `first_start` is `buckets - 1` units earlier. Hours are absolute, days are calendar days in
 * the viewer's zone, so a 23- or 25-hour day around a clock change is handled by Postgres.
 * `lo`/`hi` are the same instants as UTC wall-clock, to compare with `created_at`.
 */
function windowCte(range: Range, timeZone: string, now: Date): Prisma.Sql {
  const { unit, buckets } = RANGE_PLANS[range]
  const nowIso = now.toISOString()
  const first =
    unit === 'hour'
      ? Prisma.sql`s.last_start - ${buckets - 1}::int * interval '1 hour'`
      : Prisma.sql`((s.last_start AT TIME ZONE ${timeZone}::text) - ${buckets - 1}::int * interval '1 day') AT TIME ZONE ${timeZone}::text`
  return Prisma.sql`
    w AS (
      SELECT s.ts, s.last_start, ${first} AS first_start
      FROM (SELECT ${nowIso}::timestamptz AS ts,
                   date_trunc(${unit}::text, ${nowIso}::timestamptz, ${timeZone}::text) AS last_start) s
    ),
    win AS (
      SELECT ts, last_start, first_start,
             first_start AT TIME ZONE 'UTC' AS lo,
             ts AT TIME ZONE 'UTC' AS hi
      FROM w
    )`
}

const inWindow = Prisma.sql`l.created_at >= win.lo AND l.created_at <= win.hi`

async function prepare(options: WindowOptions) {
  const { timeZone, fallback } = await resolveTimeZone(options.timeZone)
  return { range: options.range, timeZone, timeZoneFallback: fallback, now: options.now ?? new Date() }
}
type Prepared = Awaited<ReturnType<typeof prepare>>

// ---------------------------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------------------------

export interface Summary {
  timeZone: string
  /** True when the requested zone was not recognised and UTC was used. */
  timeZoneFallback: boolean
  windowStart: Date
  windowEnd: Date
  /** Calls the gateway handled (rate-limited ones excluded). */
  totalCalls: number
  errorCalls: number
  /** errorCalls / totalCalls, or null when there were no calls. */
  errorRate: number | null
  /** Gateway end-to-end latency in ms, interpolated; null when there were no calls. */
  p50Ms: number | null
  p95Ms: number | null
  /** "At least": these rows are sampled by the gateway. */
  authFailuresAtLeast: number
  rateLimitedAtLeast: number
}

/**
 * Totals, error rate and p50/p95 for the window.
 *
 * `percentile_cont(ARRAY[0.5, 0.95]) WITHIN GROUP (ORDER BY latency_ms)` sorts the latencies once
 * and interpolates both percentiles (p50 of 100 and 200 is 150). It returns NULL on an empty
 * set, which becomes null here, and a single row's value for one row.
 */
export async function getSummary(scope: AnalyticsScope, options: WindowOptions): Promise<Summary | null> {
  const projectId = await ownedProjectId(scope)
  return projectId === null ? null : summaryFor(projectId, await prepare(options))
}

function summarySql(projectId: string, range: Range, timeZone: string, now: Date): Prisma.Sql {
  return Prisma.sql`
    WITH ${windowCte(range, timeZone, now)}
    SELECT win.lo AS first_start, win.hi AS ts,
           count(l.id) FILTER (WHERE ${COUNTED}) AS total,
           count(l.id) FILTER (WHERE ${COUNTED} AND NOT l.success) AS errors,
           count(l.id) FILTER (WHERE l.kind = 'AUTH_FAILURE') AS auth_failures,
           count(l.id) FILTER (WHERE l.error_class = 'RATE_LIMITED') AS rate_limited,
           percentile_cont(ARRAY[0.5, 0.95]) WITHIN GROUP (ORDER BY l.latency_ms) FILTER (WHERE ${COUNTED}) AS pct
    FROM win
    LEFT JOIN tool_call_logs l ON l.project_id = ${projectId} AND ${inWindow}
    GROUP BY win.lo, win.hi`
}

async function summaryFor(projectId: string, p: Prepared): Promise<Summary> {
  const [row] = await db.$queryRaw<
    {
      first_start: Date
      ts: Date
      total: bigint
      errors: bigint
      auth_failures: bigint
      rate_limited: bigint
      pct: number[] | null
    }[]
  >(summarySql(projectId, p.range, p.timeZone, p.now))
  const total = Number(row!.total)
  const errors = Number(row!.errors)
  return {
    timeZone: p.timeZone,
    timeZoneFallback: p.timeZoneFallback,
    windowStart: row!.first_start,
    windowEnd: row!.ts,
    totalCalls: total,
    errorCalls: errors,
    errorRate: total > 0 ? errors / total : null,
    p50Ms: row!.pct?.[0] ?? null,
    p95Ms: row!.pct?.[1] ?? null,
    authFailuresAtLeast: Number(row!.auth_failures),
    rateLimitedAtLeast: Number(row!.rate_limited),
  }
}

// ---------------------------------------------------------------------------------------------
// Calls over time
// ---------------------------------------------------------------------------------------------

export interface Bucket {
  /** Start of the local hour or day, as an instant. */
  start: Date
  ok: number
  errors: number
}

/**
 * Successes and errors per bucket. The bucket grid comes from `generate_series` in the viewer's
 * zone and the counts are LEFT JOINed onto it, so a bucket with no calls is a zero row, not a gap.
 */
export async function getCallsOverTime(scope: AnalyticsScope, options: WindowOptions): Promise<Bucket[] | null> {
  const projectId = await ownedProjectId(scope)
  return projectId === null ? null : callsOverTimeFor(projectId, await prepare(options))
}

function callsOverTimeSql(projectId: string, range: Range, timeZone: string, now: Date): Prisma.Sql {
  const { unit } = RANGE_PLANS[range]
  const step = unit === 'hour' ? Prisma.sql`interval '1 hour'` : Prisma.sql`interval '1 day'`
  return Prisma.sql`
    WITH ${windowCte(range, timeZone, now)},
    grid AS (
      SELECT g AS bucket_start
      FROM win, generate_series(win.first_start, win.last_start, ${step}, ${timeZone}::text) AS g
    ),
    counts AS (
      SELECT date_trunc(${unit}::text, l.created_at AT TIME ZONE 'UTC', ${timeZone}::text) AS bucket_start,
             count(*) FILTER (WHERE l.success) AS ok,
             count(*) FILTER (WHERE NOT l.success) AS errors
      FROM win
      JOIN tool_call_logs l ON l.project_id = ${projectId} AND ${inWindow}
      WHERE ${COUNTED}
      GROUP BY 1
    )
    SELECT grid.bucket_start AT TIME ZONE 'UTC' AS bucket_start, coalesce(counts.ok, 0) AS ok, coalesce(counts.errors, 0) AS errors
    FROM grid LEFT JOIN counts USING (bucket_start)
    ORDER BY grid.bucket_start`
}

async function callsOverTimeFor(projectId: string, p: Prepared): Promise<Bucket[]> {
  const rows = await db.$queryRaw<{ bucket_start: Date; ok: bigint; errors: bigint }[]>(
    callsOverTimeSql(projectId, p.range, p.timeZone, p.now)
  )
  return rows.map((r) => ({ start: r.bucket_start, ok: Number(r.ok), errors: Number(r.errors) }))
}

// ---------------------------------------------------------------------------------------------
// Top tools
// ---------------------------------------------------------------------------------------------

export interface ToolStats {
  /** The name at call time; null when the agent sent none. */
  toolName: string | null
  calls: number
  errorCalls: number
  errorRate: number
  p50Ms: number
  p95Ms: number
}

export const TOP_TOOLS_LIMIT = 10

/** Same aggregate as the summary, grouped by the tool name stored on each row (survives renames). */
export async function getTopTools(scope: AnalyticsScope, options: WindowOptions): Promise<ToolStats[] | null> {
  const projectId = await ownedProjectId(scope)
  return projectId === null ? null : topToolsFor(projectId, await prepare(options))
}

function topToolsSql(projectId: string, range: Range, timeZone: string, now: Date): Prisma.Sql {
  return Prisma.sql`
    WITH ${windowCte(range, timeZone, now)}
    SELECT l.tool_name,
           count(*) AS calls,
           count(*) FILTER (WHERE NOT l.success) AS errors,
           percentile_cont(ARRAY[0.5, 0.95]) WITHIN GROUP (ORDER BY l.latency_ms) AS pct
    FROM win
    JOIN tool_call_logs l ON l.project_id = ${projectId} AND ${inWindow}
    WHERE ${COUNTED}
    GROUP BY l.tool_name
    ORDER BY calls DESC, l.tool_name ASC NULLS LAST
    LIMIT ${TOP_TOOLS_LIMIT}`
}

async function topToolsFor(projectId: string, p: Prepared): Promise<ToolStats[]> {
  const rows = await db.$queryRaw<{ tool_name: string | null; calls: bigint; errors: bigint; pct: number[] }[]>(
    topToolsSql(projectId, p.range, p.timeZone, p.now)
  )
  return rows.map((r) => ({
    toolName: r.tool_name === '' ? null : r.tool_name,
    calls: Number(r.calls),
    errorCalls: Number(r.errors),
    errorRate: Number(r.errors) / Number(r.calls),
    p50Ms: r.pct[0]!,
    p95Ms: r.pct[1]!,
  }))
}

// ---------------------------------------------------------------------------------------------
// Recent calls
// ---------------------------------------------------------------------------------------------

export interface RecentCall {
  id: string
  createdAt: Date
  kind: 'TOOL_CALL' | 'AUTH_FAILURE'
  /** Null for auth failures (no tool involved). */
  toolName: string | null
  success: boolean
  errorClass: string | null
  latencyMs: number
  upstreamStatus: number | null
}

export interface RecentCallsPage {
  calls: RecentCall[]
  /** Pass back to get the next page; null on the last page. */
  nextCursor: string | null
}

export const RECENT_CALLS_PAGE_SIZE = 25
export const RECENT_CALLS_MAX_PAGE_SIZE = 100

export class InvalidCursorError extends Error {
  constructor() {
    super('Invalid cursor')
  }
}

/**
 * The statement for one page, newest first, keyset-paginated on (created_at, id), inside the same
 * window as every other number on the page. The redundant `created_at <=` lets Postgres use the
 * `(project_id, created_at)` index for the range; the row comparison then settles ties between
 * rows in the same millisecond.
 */
function recentCallsSql(projectId: string, range: Range, timeZone: string, now: Date, cursor: Cursor | null, limit: number): Prisma.Sql {
  const after = cursor
    ? Prisma.sql`AND l.created_at <= ${cursor.createdAt}::timestamp AND (l.created_at, l.id) < (${cursor.createdAt}::timestamp, ${cursor.id})`
    : Prisma.empty
  return Prisma.sql`
    WITH ${windowCte(range, timeZone, now)}
    SELECT l.id, l.created_at, to_char(l.created_at, 'YYYY-MM-DD"T"HH24:MI:SS.US') AS cursor_at,
           l.kind, l.tool_name, l.success, l.error_class, l.latency_ms, l.upstream_status
    FROM win
    JOIN tool_call_logs l ON l.project_id = ${projectId} AND ${inWindow} ${after}
    ORDER BY l.created_at DESC, l.id DESC
    LIMIT ${limit + 1}`
}

/**
 * Newest first, inside the selected range (the same window start as the cards, chart and top
 * tools). It lists every kind of row, including auth failures and rate-limited calls. To keep the
 * window fixed while paging, pass the first page's `now` (the summary's `windowEnd`) back in.
 */
export async function getRecentCalls(
  scope: AnalyticsScope,
  options: WindowOptions & { cursor?: string | null; limit?: number }
): Promise<RecentCallsPage | null> {
  const limit = Math.min(Math.max(options.limit ?? RECENT_CALLS_PAGE_SIZE, 1), RECENT_CALLS_MAX_PAGE_SIZE)
  let cursor: Cursor | null = null
  if (options.cursor) {
    cursor = decodeCursor(options.cursor)
    if (!cursor) throw new InvalidCursorError()
  }
  const projectId = await ownedProjectId(scope)
  return projectId === null ? null : recentCallsFor(projectId, await prepare(options), cursor, limit)
}

async function recentCallsFor(projectId: string, p: Prepared, cursor: Cursor | null, limit: number): Promise<RecentCallsPage> {
  const rows = await db.$queryRaw<
    {
      id: string
      created_at: Date
      cursor_at: string
      kind: RecentCall['kind']
      tool_name: string | null
      success: boolean
      error_class: string | null
      latency_ms: number
      upstream_status: number | null
    }[]
  >(recentCallsSql(projectId, p.range, p.timeZone, p.now, cursor, limit))

  const page = rows.slice(0, limit)
  const last = page[page.length - 1]
  return {
    calls: page.map((r) => ({
      id: r.id,
      createdAt: r.created_at,
      kind: r.kind,
      toolName: r.tool_name === '' ? null : r.tool_name,
      success: r.success,
      errorClass: r.error_class,
      latencyMs: r.latency_ms,
      upstreamStatus: r.upstream_status,
    })),
    nextCursor: rows.length > limit && last ? encodeCursor({ createdAt: last.cursor_at, id: last.id }) : null,
  }
}

// ---------------------------------------------------------------------------------------------
// One call
// ---------------------------------------------------------------------------------------------

export interface CallDetail extends RecentCall {
  errorMessage: string | null
  responseBytes: number | null
  /** The masked, truncated arguments exactly as stored. */
  input: unknown
}

/** Only fields the log row already holds. A log id from another tenant's project is simply not found. */
export async function getCallDetail(scope: AnalyticsScope, id: string): Promise<CallDetail | null> {
  const row = await db.toolCallLog.findFirst({
    where: { id, project: { slug: scope.slug, userId: scope.userId } },
    select: {
      id: true, createdAt: true, kind: true, toolName: true, success: true, errorClass: true, latencyMs: true,
      upstreamStatus: true, errorMessage: true, responseBytes: true, input: true,
    },
  })
  return row ? { ...row, toolName: row.toolName === '' ? null : row.toolName } : null
}

// ---------------------------------------------------------------------------------------------
// Whole tab
// ---------------------------------------------------------------------------------------------

/** Has this project ever logged anything? Tells "no calls yet" (empty state) from "none in this range". */
export async function hasAnyLogs(scope: AnalyticsScope): Promise<boolean | null> {
  const projectId = await ownedProjectId(scope)
  return projectId === null ? null : anyLogsFor(projectId)
}

async function anyLogsFor(projectId: string): Promise<boolean> {
  const [row] = await db.$queryRaw<{ any: boolean }[]>`
    SELECT EXISTS (SELECT 1 FROM tool_call_logs WHERE project_id = ${projectId}) AS any`
  return row!.any
}

export interface Overview {
  summary: Summary
  series: Bucket[]
  topTools: ToolStats[]
  hasAnyLogs: boolean
}

/** Everything the tab shows above the recent-calls table. Null if the user does not own the project. */
export async function getOverview(scope: AnalyticsScope, options: WindowOptions): Promise<Overview | null> {
  const projectId = await ownedProjectId(scope)
  if (projectId === null) return null
  const p = await prepare(options)
  const [summary, series, topTools, any] = await Promise.all([
    summaryFor(projectId, p),
    callsOverTimeFor(projectId, p),
    topToolsFor(projectId, p),
    anyLogsFor(projectId),
  ])
  return { summary, series, topTools, hasAnyLogs: any }
}
