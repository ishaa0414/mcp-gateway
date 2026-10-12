/**
 * The analytics seed script: refuses production and non-local databases, is scoped to one
 * project, is repeatable, and produces rows that pass the same validation as real ones.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { db, seedAnalyticsLogs, assertSeedAllowed, buildSeedEvents, SeedRefusedError } from '@mcp-gateway/db'
import { logEventSchema } from '@mcp-gateway/shared/log-event'

const LOCAL = { NODE_ENV: 'development', DATABASE_URL: 'postgresql://u:p@localhost:5432/mcpgateway_test' }
const NOW = Date.UTC(2026, 9, 12, 10, 0, 0)

let userId: string
let projectA: { id: string; slug: string }
let projectB: { id: string; slug: string }

beforeAll(async () => {
  const stamp = Date.now()
  userId = (await db.user.create({ data: { email: `seed-${stamp}@test.local`, name: 'Seed' } })).id
  const make = (suffix: string) =>
    db.project.create({
      data: { userId, name: suffix, slug: `seed-${suffix}-${stamp}`, upstreamBaseUrl: 'https://api.example.com' },
      select: { id: true, slug: true },
    })
  projectA = await make('a')
  projectB = await make('b')
})

afterAll(async () => {
  await db.project.deleteMany({ where: { userId } })
  await db.user.deleteMany({ where: { id: userId } })
  await db.$disconnect()
})

describe('assertSeedAllowed', () => {
  it('refuses NODE_ENV=production, even with a local database', () => {
    expect(() => assertSeedAllowed({ ...LOCAL, NODE_ENV: 'production' })).toThrow(SeedRefusedError)
    expect(() => assertSeedAllowed({ ...LOCAL, NODE_ENV: 'production' })).toThrow(/production/)
  })

  it.each(['localhost', '127.0.0.1', '[::1]'])('allows the local host %s', (host) => {
    expect(() => assertSeedAllowed({ NODE_ENV: 'development', DATABASE_URL: `postgresql://u:p@${host}:5432/db` })).not.toThrow()
  })

  it('allows an unset NODE_ENV with a local database', () => {
    expect(() => assertSeedAllowed({ DATABASE_URL: LOCAL.DATABASE_URL })).not.toThrow()
  })

  it.each(['db.example.com', '10.0.0.5', 'localhost.evil.com'])('refuses the non-local host %s', (host) => {
    expect(() => assertSeedAllowed({ NODE_ENV: 'development', DATABASE_URL: `postgresql://u:p@${host}:5432/db` })).toThrow(/not localhost/)
  })

  it('refuses a missing or invalid DATABASE_URL', () => {
    expect(() => assertSeedAllowed({ NODE_ENV: 'development' })).toThrow(SeedRefusedError)
    expect(() => assertSeedAllowed({ NODE_ENV: 'development', DATABASE_URL: 'not a url' })).toThrow(SeedRefusedError)
  })
})

describe('seedAnalyticsLogs', () => {
  it('writes nothing and touches nothing in production', async () => {
    const before = await db.toolCallLog.count({ where: { projectId: projectA.id } })
    await expect(seedAnalyticsLogs(db, { projectSlug: projectA.slug, now: NOW }, { ...LOCAL, NODE_ENV: 'production' })).rejects.toThrow(
      SeedRefusedError
    )
    expect(await db.toolCallLog.count({ where: { projectId: projectA.id } })).toBe(before)
  })

  it('rejects an unknown project and a bad row count', async () => {
    await expect(seedAnalyticsLogs(db, { projectSlug: 'no-such-project', now: NOW }, LOCAL)).rejects.toThrow(/No project/)
    await expect(seedAnalyticsLogs(db, { projectSlug: projectA.slug, rows: 0 }, LOCAL)).rejects.toThrow(/--rows/)
    await expect(seedAnalyticsLogs(db, { projectSlug: projectA.slug, rows: 100_001 }, LOCAL)).rejects.toThrow(/--rows/)
  })

  it('inserts rows with project-scoped ids and past timestamps, and a re-run replaces them', async () => {
    const first = await seedAnalyticsLogs(db, { projectSlug: projectA.slug, rows: 300, now: NOW }, LOCAL)
    expect(first).toMatchObject({ projectId: projectA.id, deleted: 0, written: 300 })

    const rows = await db.toolCallLog.findMany({ where: { projectId: projectA.id } })
    expect(rows).toHaveLength(300)
    expect(rows.every((r) => r.id.startsWith(`seed_${projectA.id}_`))).toBe(true)
    // The explicit past created_at is kept: everything falls inside the 7 days before NOW.
    const times = rows.map((r) => r.createdAt.getTime())
    expect(Math.max(...times)).toBeLessThanOrEqual(NOW)
    expect(Math.min(...times)).toBeGreaterThanOrEqual(NOW - 7 * 24 * 3600 * 1000)

    const second = await seedAnalyticsLogs(db, { projectSlug: projectA.slug, rows: 300, now: NOW }, LOCAL)
    expect(second).toMatchObject({ deleted: 300, written: 300 })
    expect(await db.toolCallLog.count({ where: { projectId: projectA.id } })).toBe(300)
  })

  it("never deletes a real row or another project's seed rows", async () => {
    await seedAnalyticsLogs(db, { projectSlug: projectB.slug, rows: 50, now: NOW }, LOCAL)
    await db.toolCallLog.create({
      data: { id: 'real-event-1', projectId: projectA.id, toolName: 'listPets', input: {}, latencyMs: 5, success: true, createdAt: new Date(NOW) },
    })

    await seedAnalyticsLogs(db, { projectSlug: projectA.slug, rows: 20, now: NOW }, LOCAL)

    expect(await db.toolCallLog.count({ where: { id: 'real-event-1' } })).toBe(1)
    expect(await db.toolCallLog.count({ where: { projectId: projectB.id } })).toBe(50)
    expect(await db.toolCallLog.count({ where: { projectId: projectA.id } })).toBe(21)
  })
})

describe('buildSeedEvents', () => {
  const params = { projectId: 'pid', projectSlug: 'slug', tools: [], rows: 400, now: NOW }

  it('is deterministic', () => {
    expect(buildSeedEvents(params)).toEqual(buildSeedEvents(params))
    expect(buildSeedEvents({ ...params, seed: 2 })).not.toEqual(buildSeedEvents(params))
  })

  it('produces valid events with mixed tools, errors, latencies and the odd auth failure or rate limit', () => {
    const events = buildSeedEvents(params)
    expect(events).toHaveLength(400)
    for (const e of events) expect(logEventSchema.safeParse(e).success).toBe(true)
    expect(new Set(events.map((e) => e.id)).size).toBe(400)

    const calls = events.filter((e) => e.kind === 'TOOL_CALL')
    expect(new Set(calls.map((e) => e.toolName)).size).toBeGreaterThan(3)
    expect(events.some((e) => !e.success && e.errorClass === 'UPSTREAM_5XX')).toBe(true)
    expect(events.some((e) => e.kind === 'AUTH_FAILURE')).toBe(true)
    expect(events.some((e) => e.errorClass === 'RATE_LIMITED')).toBe(true)
    const okLatencies = calls.filter((e) => e.success).map((e) => e.latencyMs)
    expect(Math.max(...okLatencies)).toBeGreaterThan(Math.min(...okLatencies) * 5)
    const errorRate = events.filter((e) => !e.success).length / events.length
    expect(errorRate).toBeGreaterThan(0.05)
    expect(errorRate).toBeLessThan(0.3)
  })
})
