/** Display helpers for the Analytics tab. Pure, so the server page and the client chart share them. */

export const NO_VALUE = '—'

/** An Intl formatter in the viewer's zone; UTC if ICU does not know a name Postgres accepted. */
function formatter(timeZone: string, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  try {
    return new Intl.DateTimeFormat('en-GB', { ...options, timeZone, hourCycle: 'h23' })
  } catch {
    return new Intl.DateTimeFormat('en-GB', { ...options, timeZone: 'UTC', hourCycle: 'h23' })
  }
}

function parts(date: Date, timeZone: string, options: Intl.DateTimeFormatOptions): Record<string, string> {
  const out: Record<string, string> = {}
  for (const p of formatter(timeZone, options).formatToParts(date)) out[p.type] = p.value
  return out
}

/** `6 Oct, 00:00 IST` (the zone name falls back to `GMT+5:30` where there is no abbreviation). */
export function formatInstant(date: Date, timeZone: string): string {
  const p = parts(date, timeZone, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZoneName: 'short' })
  return `${p['day']} ${p['month']}, ${p['hour']}:${p['minute']} ${p['timeZoneName']}`
}

/** `6 Oct, 15:30:12`, for table rows (the zone is stated once above the table). */
export function formatRowTime(date: Date, timeZone: string): string {
  const p = parts(date, timeZone, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit' })
  return `${p['day']} ${p['month']}, ${p['hour']}:${p['minute']}:${p['second']}`
}

/** `15:00` for hourly buckets, `6 Oct` for daily ones. */
export function formatBucketLabel(date: Date, timeZone: string, unit: 'hour' | 'day'): string {
  if (unit === 'hour') {
    const p = parts(date, timeZone, { hour: '2-digit', minute: '2-digit' })
    return `${p['hour']}:${p['minute']}`
  }
  const p = parts(date, timeZone, { day: 'numeric', month: 'short' })
  return `${p['day']} ${p['month']}`
}

/** Tooltip title: the hour (`6 Oct, 15:00`) or the day (`Mon 6 Oct`). */
export function formatBucketTitle(date: Date, timeZone: string, unit: 'hour' | 'day'): string {
  if (unit === 'hour') {
    const p = parts(date, timeZone, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
    return `${p['day']} ${p['month']}, ${p['hour']}:${p['minute']}`
  }
  const p = parts(date, timeZone, { weekday: 'short', day: 'numeric', month: 'short' })
  return `${p['weekday']} ${p['day']} ${p['month']}`
}

export function formatMs(ms: number | null): string {
  if (ms === null) return NO_VALUE
  return ms >= 1000 ? `${(ms / 1000).toFixed(2)} s` : `${Math.round(ms)} ms`
}

export function formatPercent(rate: number | null): string {
  if (rate === null) return NO_VALUE
  const pct = rate * 100
  return `${pct === 0 || pct >= 10 ? pct.toFixed(0) : pct.toFixed(1)}%`
}

export function formatBytes(bytes: number | null): string {
  if (bytes === null) return NO_VALUE
  if (bytes < 1024) return `${bytes} B`
  return bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

/** The top of the y axis: the smallest 1, 2, 5 × 10ⁿ that holds `max` (at least 4, so a single call is not a full-height bar). */
export function niceMax(max: number): number {
  if (max <= 4) return 4
  const magnitude = 10 ** Math.floor(Math.log10(max))
  for (const step of [1, 2, 5, 10]) if (step * magnitude >= max) return step * magnitude
  return 10 * magnitude
}
