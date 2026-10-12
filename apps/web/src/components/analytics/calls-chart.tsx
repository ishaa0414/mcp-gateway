'use client'
import { useState } from 'react'
import { formatBucketLabel, formatBucketTitle, niceMax } from '@/lib/analytics/format'

export interface ChartBucket {
  /** ISO instant of the start of the local hour or day. */
  start: string
  ok: number
  errors: number
}

const W = 720
const H = 240
const MARGIN = { top: 12, right: 8, bottom: 28, left: 36 }
const PLOT_W = W - MARGIN.left - MARGIN.right
const PLOT_H = H - MARGIN.top - MARGIN.bottom
const GAP = 2 // gap between the two stacked segments

/** Categorical slots 1 and 2 of the reference palette, light and dark. */
const OK_FILL = 'fill-[#2a78d6] dark:fill-[#3987e5]'
const ERR_FILL = 'fill-[#eb6834] dark:fill-[#d95926]'
const OK_SWATCH = 'bg-[#2a78d6] dark:bg-[#3987e5]'
const ERR_SWATCH = 'bg-[#eb6834] dark:bg-[#d95926]'

/**
 * Calls per hour or day, successes and errors stacked. Hand-drawn SVG: the bars are the data, the
 * tooltip is an HTML box over it, and a visually hidden table carries the same numbers for screen
 * readers (the SVG itself is one labelled image).
 */
export function CallsChart({ buckets, timeZone, unit }: { buckets: ChartBucket[]; timeZone: string; unit: 'hour' | 'day' }) {
  const [active, setActive] = useState<number | null>(null)

  const max = niceMax(Math.max(0, ...buckets.map((b) => b.ok + b.errors)))
  const slot = PLOT_W / buckets.length
  const barW = Math.max(2, slot * 0.7)
  const y = (n: number) => MARGIN.top + PLOT_H - (n / max) * PLOT_H
  const ticks = [0, max / 2, max]
  // About six labels across, whatever the number of buckets.
  const labelEvery = Math.ceil(buckets.length / 6)
  const total = buckets.reduce((sum, b) => sum + b.ok + b.errors, 0)
  const unitWord = unit === 'hour' ? 'hour' : 'day'

  const hovered = active === null ? null : buckets[active]!
  const tooltipLeftPct = active === null ? 0 : ((MARGIN.left + slot * (active + 0.5)) / W) * 100

  return (
    <figure className="m-0">
      <div className="relative">
        <svg
          viewBox={`0 0 ${W} ${H}`}
          className="h-auto w-full"
          role="img"
          aria-label={`Calls per ${unitWord}, successes and errors. ${total} calls in total. The same numbers are in the table below.`}
          onMouseLeave={() => setActive(null)}
        >
          {ticks.map((t) => (
            <g key={t}>
              <line x1={MARGIN.left} x2={W - MARGIN.right} y1={y(t)} y2={y(t)} className="stroke-border" strokeWidth={1} />
              <text x={MARGIN.left - 6} y={y(t)} textAnchor="end" dominantBaseline="middle" className="fill-muted-foreground text-[11px]">
                {Number.isInteger(t) ? t : ''}
              </text>
            </g>
          ))}
          {buckets.map((b, i) => {
            const x = MARGIN.left + slot * i + (slot - barW) / 2
            const okH = (b.ok / max) * PLOT_H
            const errH = (b.errors / max) * PLOT_H
            const baseline = MARGIN.top + PLOT_H
            return (
              <g key={b.start} onMouseEnter={() => setActive(i)}>
                {/* A full-height hit target, wider than the bar, so thin or empty bars can be hovered. */}
                <rect x={MARGIN.left + slot * i} y={MARGIN.top} width={slot} height={PLOT_H} fill="transparent" />
                {active === i && <rect x={MARGIN.left + slot * i} y={MARGIN.top} width={slot} height={PLOT_H} className="fill-muted" />}
                {b.ok > 0 && <rect x={x} y={baseline - okH} width={barW} height={okH} rx={2} className={OK_FILL} />}
                {b.errors > 0 && (
                  <rect x={x} y={baseline - okH - errH - (b.ok > 0 ? GAP : 0)} width={barW} height={errH} rx={2} className={ERR_FILL} />
                )}
              </g>
            )
          })}
          {buckets.map((b, i) =>
            i % labelEvery === 0 ? (
              <text key={b.start} x={MARGIN.left + slot * (i + 0.5)} y={H - 8} textAnchor="middle" className="fill-muted-foreground text-[11px]">
                {formatBucketLabel(new Date(b.start), timeZone, unit)}
              </text>
            ) : null
          )}
        </svg>

        {hovered && (
          <div
            className="pointer-events-none absolute top-2 z-10 -translate-x-1/2 rounded-md border bg-popover px-3 py-2 text-xs text-popover-foreground shadow-md"
            style={{ left: `clamp(70px, ${tooltipLeftPct}%, calc(100% - 70px))` }}
          >
            <p className="font-medium">{formatBucketTitle(new Date(hovered.start), timeZone, unit)}</p>
            <p className="flex items-center gap-1.5 pt-1"><span className={`h-2 w-2 rounded-sm ${OK_SWATCH}`} />Successes: {hovered.ok}</p>
            <p className="flex items-center gap-1.5"><span className={`h-2 w-2 rounded-sm ${ERR_SWATCH}`} />Errors: {hovered.errors}</p>
          </div>
        )}
      </div>

      <figcaption className="flex gap-4 pt-2 text-xs text-muted-foreground">
        <span className="flex items-center gap-1.5"><span className={`h-2 w-2 rounded-sm ${OK_SWATCH}`} />Successes</span>
        <span className="flex items-center gap-1.5"><span className={`h-2 w-2 rounded-sm ${ERR_SWATCH}`} />Errors</span>
      </figcaption>

      <table className="sr-only">
        <caption>Calls per {unitWord}</caption>
        <thead>
          <tr><th scope="col">{unit === 'hour' ? 'Hour' : 'Day'}</th><th scope="col">Successes</th><th scope="col">Errors</th></tr>
        </thead>
        <tbody>
          {buckets.map((b) => (
            <tr key={b.start}>
              <th scope="row">{formatBucketTitle(new Date(b.start), timeZone, unit)}</th>
              <td>{b.ok}</td>
              <td>{b.errors}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </figure>
  )
}
