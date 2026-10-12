'use client'
import { useState, useTransition } from 'react'
import { loadCallDetail, loadMoreCalls, type CallDetailView } from '@/actions/analytics'
import type { RecentCallRow } from '@/lib/analytics/rows'
import type { Range } from '@/lib/analytics/range'
import { formatBytes, formatMs, formatRowTime, NO_VALUE } from '@/lib/analytics/format'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'

interface Props {
  slug: string
  range: Range
  timeZone: string
  /** The first page's windowEnd, sent back as `now` so the window stays put while paging. */
  windowEnd: string
  initial: { calls: RecentCallRow[]; nextCursor: string | null }
}

const KIND_LABEL: Record<RecentCallRow['kind'], string> = { TOOL_CALL: 'Tool call', AUTH_FAILURE: 'Auth failure' }

export function RecentCalls({ slug, range, timeZone, windowEnd, initial }: Props) {
  const [calls, setCalls] = useState(initial.calls)
  const [cursor, setCursor] = useState(initial.nextCursor)
  const [error, setError] = useState<string | null>(null)
  const [loading, startLoading] = useTransition()
  const [selected, setSelected] = useState<RecentCallRow | null>(null)

  function loadMore() {
    if (!cursor) return
    setError(null)
    startLoading(async () => {
      const res = await loadMoreCalls({ slug, range, timeZone, now: windowEnd, cursor })
      if (!res.ok) {
        setError('Could not load more calls. Reload the page and try again.')
        return
      }
      const seen = new Set(calls.map((c) => c.id))
      setCalls([...calls, ...res.data.calls.filter((c) => !seen.has(c.id))])
      setCursor(res.data.nextCursor)
    })
  }

  if (calls.length === 0) return <p className="py-6 text-center text-sm text-muted-foreground">No calls in this range.</p>

  return (
    <div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b text-left text-xs text-muted-foreground">
              <th className="py-2 pr-4 font-medium">Time</th>
              <th className="py-2 pr-4 font-medium">Tool</th>
              <th className="py-2 pr-4 font-medium">Result</th>
              <th className="py-2 pr-4 text-right font-medium">Latency</th>
              <th className="py-2 text-right font-medium">Upstream</th>
            </tr>
          </thead>
          <tbody>
            {calls.map((c) => (
              <tr key={c.id} className="cursor-pointer border-b last:border-0 hover:bg-muted/50" onClick={() => setSelected(c)}>
                <td className="whitespace-nowrap py-2 pr-4">
                  <button
                    type="button"
                    className="rounded text-left underline-offset-2 hover:underline focus-visible:outline focus-visible:outline-2"
                    onClick={(e) => {
                      e.stopPropagation()
                      setSelected(c)
                    }}
                  >
                    {formatRowTime(new Date(c.createdAt), timeZone)}
                    <span className="sr-only">, show details</span>
                  </button>
                </td>
                <td className="py-2 pr-4">
                  {c.toolName ? (
                    <span className="font-mono text-xs">{c.toolName}</span>
                  ) : (
                    <span className="flex items-center gap-2">
                      {NO_VALUE}
                      <Badge variant="outline">{KIND_LABEL[c.kind]}</Badge>
                    </span>
                  )}
                </td>
                <td className="py-2 pr-4">
                  {c.success ? <Badge variant="secondary">OK</Badge> : <Badge variant="destructive">{c.errorClass ?? 'Error'}</Badge>}
                </td>
                <td className="whitespace-nowrap py-2 pr-4 text-right tabular-nums">{formatMs(c.latencyMs)}</td>
                <td className="py-2 text-right tabular-nums">{c.upstreamStatus ?? NO_VALUE}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="flex items-center gap-3 pt-3">
        {cursor ? (
          <Button variant="outline" size="sm" onClick={loadMore} disabled={loading}>
            {loading ? 'Loading…' : 'Load more'}
          </Button>
        ) : (
          <p className="text-xs text-muted-foreground">That is every call in this range.</p>
        )}
        {error && (
          <p role="alert" className="text-xs text-destructive">
            {error}
          </p>
        )}
      </div>

      <CallDialog slug={slug} timeZone={timeZone} call={selected} onClose={() => setSelected(null)} />
    </div>
  )
}

type DetailState = { id: string; result: 'loading' | 'error' | CallDetailView }

function CallDialog({ slug, timeZone, call, onClose }: { slug: string; timeZone: string; call: RecentCallRow | null; onClose: () => void }) {
  const [detail, setDetail] = useState<DetailState | null>(null)

  // Fetch when a different call is opened. State is keyed by id, so an old answer never shows for a new row.
  if (call && detail?.id !== call.id) {
    setDetail({ id: call.id, result: 'loading' })
    void loadCallDetail({ slug, id: call.id }).then((res) =>
      setDetail((d) => (d?.id === call.id ? { id: call.id, result: res.ok ? res.data : 'error' } : d))
    )
  }
  const result = call && detail?.id === call.id ? detail.result : null

  return (
    <Dialog
      open={call !== null}
      onOpenChange={(open) => {
        if (!open) {
          onClose()
          setDetail(null)
        }
      }}
    >
      <DialogContent className="max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="font-mono text-base">{call?.toolName ?? `${NO_VALUE} (${call ? KIND_LABEL[call.kind] : ''})`}</DialogTitle>
          <DialogDescription>{call ? formatRowTime(new Date(call.createdAt), timeZone) : ''}</DialogDescription>
        </DialogHeader>
        {result === 'loading' && <p className="text-sm text-muted-foreground">Loading…</p>}
        {result === 'error' && (
          <p role="alert" className="text-sm text-destructive">
            Could not load this call.
          </p>
        )}
        {result && typeof result === 'object' && (
          <dl className="space-y-4 text-sm">
            <div>
              <dt className="text-xs font-medium text-muted-foreground">Input (masked)</dt>
              <dd>
                <pre className="mt-1 max-h-64 overflow-auto rounded-md bg-muted p-3 text-xs">{JSON.stringify(result.input, null, 2) ?? NO_VALUE}</pre>
              </dd>
            </div>
            <div>
              <dt className="text-xs font-medium text-muted-foreground">Error message</dt>
              <dd className="mt-1 break-words">{result.errorMessage ?? NO_VALUE}</dd>
            </div>
            <div>
              <dt className="text-xs font-medium text-muted-foreground">Response size</dt>
              <dd className="mt-1">{formatBytes(result.responseBytes)}</dd>
            </div>
          </dl>
        )}
      </DialogContent>
    </Dialog>
  )
}
