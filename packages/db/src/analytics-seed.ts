import type { LogErrorClass, LogEvent } from '@mcp-gateway/shared/log-event'
import type { PrismaClient } from './generated/client/client.js'
import { writeLogBatch } from './log-store.js'

/**
 * Development helper: fill a project with realistic call logs so the analytics dashboard has
 * something to show. It writes through `writeLogBatch`, so every row passes the same validation
 * as a real one. It refuses to run in production and against a non-local database.
 */

export const DEFAULT_SEED_ROWS = 400
export const MAX_SEED_ROWS = 100_000
const DAY_MS = 24 * 60 * 60 * 1000
const MASKED = '[MASKED]' // what packages/shared/src/mask.ts stores for a secret

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]'])

export class SeedRefusedError extends Error {}

/** Throws unless this looks like a local development database. Checked before anything connects. */
export function assertSeedAllowed(env: { NODE_ENV?: string | undefined; DATABASE_URL?: string | undefined }): void {
  if (env.NODE_ENV === 'production') {
    throw new SeedRefusedError('Refusing to seed analytics data: NODE_ENV is "production".')
  }
  let host: string
  try {
    host = new URL(env.DATABASE_URL ?? '').hostname
  } catch {
    throw new SeedRefusedError('Refusing to seed analytics data: DATABASE_URL is missing or not a valid URL.')
  }
  if (!LOCAL_HOSTS.has(host.toLowerCase())) {
    throw new SeedRefusedError(`Refusing to seed analytics data: the database host "${host}" is not localhost, 127.0.0.1 or ::1.`)
  }
}

/** Small deterministic PRNG (mulberry32), so a seeded dataset is the same every run and its numbers can be checked. */
export function createRandom(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

interface SeedTool {
  id: string | null
  name: string
  /** Median latency of a successful call, ms. */
  medianMs: number
  /** Relative call volume. */
  weight: number
}

const FALLBACK_TOOLS = ['listPets', 'getPetById', 'findPetsByStatus', 'addPet', 'updatePet', 'getOrderById', 'deleteOrder']

/** Build the event list. Pure: the same inputs give the same events. */
export function buildSeedEvents(params: {
  projectId: string
  projectSlug: string
  tools: readonly { id: string | null; name: string }[]
  rows: number
  now: number
  seed?: number
}): LogEvent[] {
  const { projectId, projectSlug, rows, now } = params
  const random = createRandom(params.seed ?? 1)
  const pick = (n: number) => Math.floor(random() * n)
  const between = (lo: number, hi: number) => lo + Math.floor(random() * (hi - lo + 1))
  // Log-normal around a median: most calls near it, a long tail of slow ones.
  const lognormal = (median: number, sigma: number) => {
    const u = Math.max(random(), 1e-9)
    const normal = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * random())
    return Math.max(1, Math.round(median * Math.exp(sigma * normal)))
  }

  const source = params.tools.length > 0 ? params.tools : FALLBACK_TOOLS.map((name) => ({ id: null, name }))
  const tools: SeedTool[] = source.map((t, i) => ({
    id: t.id,
    name: t.name,
    medianMs: 60 + ((i * 97) % 500), // varied per tool
    weight: 1 / (i + 1), // a few busy tools and a long tail
  }))
  const totalWeight = tools.reduce((sum, t) => sum + t.weight, 0)
  const pickTool = () => {
    let r = random() * totalWeight
    for (const t of tools) {
      r -= t.weight
      if (r <= 0) return t
    }
    return tools[tools.length - 1]!
  }

  // More calls in the working day than at night, more on recent days than old ones.
  const pickTime = () => {
    for (;;) {
      const t = now - Math.floor(random() * 7 * DAY_MS)
      const hour = new Date(t).getUTCHours()
      const daytime = hour >= 4 && hour < 17 ? 1 : 0.25 // roughly 09:30-22:30 IST
      const recency = 0.5 + 0.5 * (1 - (now - t) / (7 * DAY_MS))
      if (random() < daytime * recency) return t
    }
  }

  const events: LogEvent[] = []
  for (let n = 0; n < rows; n++) {
    const id = `seed_${projectId}_${n}`
    const timestamp = pickTime()
    const roll = random()

    if (roll < 0.015) {
      // Sampled auth failure: only the slug and a reason are known.
      const errorClass: LogErrorClass = random() < 0.6 ? 'AUTH_INVALID' : 'AUTH_MISSING'
      events.push({
        id, kind: 'AUTH_FAILURE', projectSlug, apiKeyId: null, toolId: null, toolName: null, input: {},
        upstreamStatus: null, latencyMs: 0, success: false, errorClass, errorMessage: null, responseBytes: null, timestamp,
      })
      continue
    }

    const tool = pickTool()
    const base = { id, kind: 'TOOL_CALL' as const, projectId, apiKeyId: null, toolId: tool.id, toolName: tool.name, timestamp }
    const input: Record<string, unknown> = random() < 0.5 ? { id: between(1, 500) } : { status: ['available', 'pending', 'sold'][pick(3)] }
    if (random() < 0.1) input['api_key'] = MASKED

    if (roll < 0.035) {
      events.push({
        ...base, input, upstreamStatus: null, latencyMs: 0, success: false,
        errorClass: 'RATE_LIMITED', errorMessage: 'Rate limit exceeded', responseBytes: null,
      })
    } else if (roll < 0.055) {
      events.push({
        ...base, input: {}, upstreamStatus: null, latencyMs: between(1, 6), success: false,
        errorClass: 'VALIDATION', errorMessage: `Invalid arguments for "${tool.name}": id must be integer`, responseBytes: null,
      })
    } else if (roll < 0.1) {
      const status = [400, 404, 404, 422][pick(4)]!
      events.push({
        ...base, input, upstreamStatus: status, latencyMs: lognormal(tool.medianMs * 0.8, 0.4), success: false,
        errorClass: 'UPSTREAM_4XX', errorMessage: `Upstream returned HTTP ${status}`, responseBytes: between(40, 300),
      })
    } else if (roll < 0.135) {
      const status = [500, 502, 503][pick(3)]!
      events.push({
        ...base, input, upstreamStatus: status, latencyMs: lognormal(tool.medianMs * 1.5, 0.6), success: false,
        errorClass: 'UPSTREAM_5XX', errorMessage: `Upstream returned HTTP ${status}`, responseBytes: between(0, 200),
      })
    } else if (roll < 0.145) {
      events.push({
        ...base, input, upstreamStatus: null, latencyMs: 15_000, success: false,
        errorClass: 'TIMEOUT', errorMessage: 'The upstream API did not answer in time', responseBytes: null,
      })
    } else {
      events.push({
        ...base, input, upstreamStatus: 200, latencyMs: lognormal(tool.medianMs, 0.5), success: true,
        errorClass: null, errorMessage: null, responseBytes: between(120, 20_000),
      })
    }
  }
  return events
}

export interface SeedResult {
  projectId: string
  /** Earlier seed rows of this project that were removed first. */
  deleted: number
  written: number
}

/**
 * Replace the seed rows of one project. Seed ids are `seed_<projectId>_<n>`, and the delete matches
 * only that prefix for that project, so real rows and other projects are never touched.
 */
export async function seedAnalyticsLogs(
  db: PrismaClient,
  options: { projectSlug: string; rows?: number; now?: number; seed?: number },
  env: { NODE_ENV?: string | undefined; DATABASE_URL?: string | undefined } = process.env
): Promise<SeedResult> {
  assertSeedAllowed(env)

  const rows = options.rows ?? DEFAULT_SEED_ROWS
  if (!Number.isInteger(rows) || rows < 1 || rows > MAX_SEED_ROWS) {
    throw new SeedRefusedError(`--rows must be a whole number between 1 and ${MAX_SEED_ROWS}.`)
  }

  const project = await db.project.findUnique({ where: { slug: options.projectSlug }, select: { id: true, slug: true } })
  if (!project) throw new SeedRefusedError(`No project with slug "${options.projectSlug}".`)

  const tools = await db.tool.findMany({
    where: { projectId: project.id, enabled: true, removedAt: null },
    select: { id: true, name: true },
    orderBy: { name: 'asc' },
  })

  const events = buildSeedEvents({
    projectId: project.id,
    projectSlug: project.slug,
    tools,
    rows,
    now: options.now ?? Date.now(),
    ...(options.seed !== undefined ? { seed: options.seed } : {}),
  })

  // Both conditions: the project pins the tenant, the prefix pins the seed rows.
  const deleted = await db.toolCallLog.deleteMany({ where: { projectId: project.id, id: { startsWith: `seed_${project.id}_` } } })

  let written = 0
  for (let i = 0; i < events.length; i += 1000) {
    const result = await writeLogBatch(db, events.slice(i, i + 1000))
    written += result.written
  }
  return { projectId: project.id, deleted: deleted.count, written }
}
