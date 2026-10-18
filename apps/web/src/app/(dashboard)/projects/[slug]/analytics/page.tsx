import { cookies } from 'next/headers'
import { notFound, redirect } from 'next/navigation'
import Link from 'next/link'
import { z } from 'zod'
import { auth } from '@/auth'
import { toRow } from '@/lib/analytics/rows'
import { getOverview, getRecentCalls } from '@/lib/analytics/queries'
import { DEFAULT_RANGE, RANGE_PLANS, RANGES, type Range } from '@/lib/analytics/range'
import { VIEWER_TZ_COOKIE } from '@/lib/analytics/viewer-tz'
import { formatAtLeast, formatInstant, formatMs, formatPercent, NO_VALUE } from '@/lib/analytics/format'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { CallsChart } from '@/components/analytics/calls-chart'
import { RecentCalls } from '@/components/analytics/recent-calls'
import { TimeZoneSync } from '@/components/analytics/time-zone-sync'
import { cn } from '@/lib/utils'

// An unknown or missing ?range= is the default, never an error page.
const SearchParams = z.object({ range: z.enum(RANGES).catch(DEFAULT_RANGE) })

const RANGE_LABEL: Record<Range, string> = { '24h': '24 h', '7d': '7 d', '30d': '30 d' }

interface Props {
  params: Promise<{ slug: string }>
  searchParams: Promise<Record<string, string | string[] | undefined>>
}

export default async function AnalyticsPage({ params, searchParams }: Props) {
  const { slug } = await params
  const session = await auth()
  if (!session?.user?.id) redirect('/sign-in')
  const scope = { userId: session.user.id, slug }

  const { range } = SearchParams.parse(await searchParams)
  const viewerZone = (await cookies()).get(VIEWER_TZ_COOKIE)?.value

  // First visit: the server cannot know the viewer's zone yet. Show a skeleton while the client
  // reports it (setting the cookie) and refreshes.
  if (viewerZone === undefined) {
    return (
      <>
        <TimeZoneSync />
        <AnalyticsSkeleton />
      </>
    )
  }

  const now = new Date()
  const overview = await getOverview(scope, { range, timeZone: viewerZone, now })
  if (!overview) notFound()
  const { summary, series, topTools, hasAnyLogs } = overview

  // Same range, zone and `now` as the cards, so the table adds up to them.
  const recent = hasAnyLogs ? await getRecentCalls(scope, { range, timeZone: summary.timeZone, now }) : null
  const unit = RANGE_PLANS[range].unit

  return (
    <div className="max-w-5xl space-y-6">
      <div className="space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <RangePicker slug={slug} range={range} />
          {summary.timeZoneFallback && (
            <p className="text-xs text-muted-foreground">Showing UTC (your browser&apos;s time zone was not recognised)</p>
          )}
        </div>
        <p className="text-sm text-muted-foreground">
          Since {formatInstant(summary.windowStart, summary.timeZone)}
        </p>
      </div>

      {!hasAnyLogs ? (
        <Card>
          <CardHeader>
            <CardTitle>No calls yet</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm text-muted-foreground">
            <p>Calls appear here a few seconds after an agent makes them.</p>
            <p>
              To try it, connect <span className="font-medium text-foreground">MCP Inspector</span> to this project&apos;s endpoint with an API key
              and run a tool. The connection snippet is on the{' '}
              <Link href={`/projects/${slug}/overview`} className="underline underline-offset-2">
                Overview
              </Link>{' '}
              tab; keys are on the{' '}
              <Link href={`/projects/${slug}/api-keys`} className="underline underline-offset-2">
                API Keys
              </Link>{' '}
              tab.
            </p>
          </CardContent>
        </Card>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-3">
            <Stat title="Calls" value={summary.totalCalls.toLocaleString('en-US')} note="excludes rate-limited" />
            <Stat
              title="Error rate"
              value={formatPercent(summary.errorRate)}
              note={`${summary.errorCalls.toLocaleString('en-US')} of ${summary.totalCalls.toLocaleString('en-US')} calls`}
            />
            <Stat title="Auth failures" value={formatAtLeast(summary.authFailuresAtLeast)} note="sampled by the gateway" />
            <Stat title="Latency p50" value={formatMs(summary.p50Ms)} note="gateway end-to-end" />
            <Stat title="Latency p95" value={formatMs(summary.p95Ms)} note="gateway end-to-end" />
            <Stat title="Rate limited" value={formatAtLeast(summary.rateLimitedAtLeast)} note="sampled by the gateway" />
          </div>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Calls per {unit}</CardTitle>
            </CardHeader>
            <CardContent>
              {summary.totalCalls === 0 && <p className="pb-2 text-sm text-muted-foreground">No calls in this range.</p>}
              <CallsChart
                buckets={series.map((b) => ({ start: b.start.toISOString(), ok: b.ok, errors: b.errors }))}
                timeZone={summary.timeZone}
                unit={unit}
              />
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Top tools</CardTitle>
            </CardHeader>
            <CardContent>
              {topTools.length === 0 ? (
                <p className="text-sm text-muted-foreground">No tool calls in this range.</p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b text-left text-xs text-muted-foreground">
                        <th className="py-2 pr-4 font-medium">Tool</th>
                        <th className="py-2 pr-4 text-right font-medium">Calls</th>
                        <th className="py-2 pr-4 text-right font-medium">Error rate</th>
                        <th className="py-2 pr-4 text-right font-medium">p50</th>
                        <th className="py-2 text-right font-medium">p95</th>
                      </tr>
                    </thead>
                    <tbody>
                      {topTools.map((t) => (
                        <tr key={t.toolName ?? '(none)'} className="border-b last:border-0">
                          <td className="py-2 pr-4">{t.toolName ? <span className="font-mono text-xs">{t.toolName}</span> : NO_VALUE}</td>
                          <td className="py-2 pr-4 text-right tabular-nums">{t.calls.toLocaleString('en-US')}</td>
                          <td className="py-2 pr-4 text-right tabular-nums">{formatPercent(t.errorRate)}</td>
                          <td className="py-2 pr-4 text-right tabular-nums">{formatMs(t.p50Ms)}</td>
                          <td className="py-2 text-right tabular-nums">{formatMs(t.p95Ms)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Recent calls</CardTitle>
              <p className="text-xs text-muted-foreground">Times in {summary.timeZone}. Includes auth failures and rate-limited calls.</p>
            </CardHeader>
            <CardContent>
              {recent && (
                <RecentCalls
                  // A new range or zone is a new list, not an append to the old one.
                  key={`${range}|${summary.timeZone}|${summary.windowEnd.toISOString()}`}
                  slug={slug}
                  range={range}
                  timeZone={summary.timeZone}
                  windowEnd={summary.windowEnd.toISOString()}
                  initial={{ calls: recent.calls.map(toRow), nextCursor: recent.nextCursor }}
                />
              )}
            </CardContent>
          </Card>
        </>
      )}
    </div>
  )
}

function RangePicker({ slug, range }: { slug: string; range: Range }) {
  return (
    <nav aria-label="Time range" className="inline-flex rounded-md border p-0.5">
      {RANGES.map((r) => (
        <Link
          key={r}
          href={`/projects/${slug}/analytics?range=${r}`}
          aria-current={r === range ? 'page' : undefined}
          className={cn(
            'rounded px-3 py-1 text-sm font-medium transition-colors',
            r === range ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground'
          )}
        >
          {RANGE_LABEL[r]}
        </Link>
      ))}
    </nav>
  )
}

function Stat({ title, value, note }: { title: string; value: string; note: string }) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium text-muted-foreground">{title}</CardTitle>
      </CardHeader>
      <CardContent>
        <p className="text-2xl font-bold tabular-nums">{value}</p>
        <p className="text-xs text-muted-foreground">{note}</p>
      </CardContent>
    </Card>
  )
}

function AnalyticsSkeleton() {
  return (
    <div className="max-w-5xl animate-pulse space-y-6" aria-busy="true" aria-label="Loading analytics">
      <div className="h-8 w-48 rounded bg-muted" />
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-3">
        {Array.from({ length: 6 }, (_, i) => (
          <div key={i} className="h-24 rounded-lg bg-muted" />
        ))}
      </div>
      <div className="h-64 rounded-lg bg-muted" />
    </div>
  )
}
