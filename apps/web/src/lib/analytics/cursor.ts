/**
 * Keyset cursor for the recent-calls list: the last row's created_at and id. The timestamp is
 * carried as text with microsecond precision straight from Postgres, so it compares exactly
 * with the column whatever the column's precision is (it is milliseconds today).
 */
export interface Cursor {
  /** `YYYY-MM-DDTHH:MM:SS.ffffff`, UTC, as produced by the recent-calls query. */
  createdAt: string
  id: string
}

const TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.\d{6}$/
const MAX_CURSOR_CHARS = 200
const MAX_ID_CHARS = 64

export function encodeCursor(cursor: Cursor): string {
  return Buffer.from(`${cursor.createdAt}|${cursor.id}`, 'utf8').toString('base64url')
}

/** Returns null for anything that is not a cursor this module produced. */
export function decodeCursor(value: unknown): Cursor | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_CURSOR_CHARS) return null
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return null
  const text = Buffer.from(value, 'base64url').toString('utf8')
  const sep = text.indexOf('|')
  if (sep < 0) return null
  const createdAt = text.slice(0, sep)
  const id = text.slice(sep + 1)
  if (id.length === 0 || id.length > MAX_ID_CHARS) return null

  const m = TIMESTAMP.exec(createdAt)
  if (!m) return null
  // Reject dates like 2026-02-31 that Date would roll over but Postgres would refuse.
  const [y, mo, d, h, mi, s] = m.slice(1).map(Number) as [number, number, number, number, number, number]
  const check = new Date(Date.UTC(y, mo - 1, d, h, mi, s))
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d) return null
  if (h > 23 || mi > 59 || s > 59) return null
  return { createdAt, id }
}
