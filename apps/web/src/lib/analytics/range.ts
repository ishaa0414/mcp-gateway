/** The time ranges the Analytics tab offers. Retention is 30 days, so 30 d is the longest. */
export const RANGES = ['24h', '7d', '30d'] as const
export type Range = (typeof RANGES)[number]
export const DEFAULT_RANGE: Range = '7d'

export type BucketUnit = 'hour' | 'day'

/** 24 h is 24 hourly buckets; 7 d and 30 d are that many local days, today included. */
export const RANGE_PLANS: Record<Range, { unit: BucketUnit; buckets: number }> = {
  '24h': { unit: 'hour', buckets: 24 },
  '7d': { unit: 'day', buckets: 7 },
  '30d': { unit: 'day', buckets: 30 },
}

export function parseRange(value: unknown): Range {
  return RANGES.find((r) => r === value) ?? DEFAULT_RANGE
}
