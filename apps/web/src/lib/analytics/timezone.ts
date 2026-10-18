import { db } from '@/lib/db'

/** Characters in IANA names such as `Etc/GMT+5` and `America/Argentina/Buenos_Aires`. */
const TIME_ZONE_PATTERN = /^[A-Za-z0-9_+\-/]{1,64}$/

let knownZones: Promise<Set<string>> | undefined

/** The names Postgres itself accepts, loaded once per process. */
function loadKnownZones(): Promise<Set<string>> {
  knownZones ??= db.$queryRaw<{ name: string }[]>`SELECT name FROM pg_timezone_names`
    .then((rows) => new Set(rows.map((r) => r.name)))
    .catch((err) => {
      knownZones = undefined // do not cache a failure
      throw err
    })
  return knownZones
}

/**
 * Turn what the browser reported into a zone the database accepts. Anything that is not a known
 * Postgres zone name (a typo, junk, an injection attempt) becomes UTC, and `fallback` says so.
 * The result only ever reaches SQL as a bound parameter.
 */
export async function resolveTimeZone(input: unknown): Promise<{ timeZone: string; fallback: boolean }> {
  if (typeof input === 'string' && TIME_ZONE_PATTERN.test(input) && (await loadKnownZones()).has(input)) {
    return { timeZone: input, fallback: false }
  }
  return { timeZone: 'UTC', fallback: true }
}
