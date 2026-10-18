import type { RecentCall } from './queries'

/** A recent call as it crosses to the browser: the instant is an ISO string. */
export interface RecentCallRow extends Omit<RecentCall, 'createdAt'> {
  createdAt: string
}

export function toRow(call: RecentCall): RecentCallRow {
  return { ...call, createdAt: call.createdAt.toISOString() }
}
