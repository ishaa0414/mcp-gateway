import { randomUUID } from 'node:crypto'
import { db, purgeOldLogs, writeLogBatch } from '@mcp-gateway/db'
import type { LogEvent } from '@mcp-gateway/shared'
import { afterAll, describe, expect, it } from 'vitest'
import { testDatabaseUrl } from '@mcp-gateway/db/test-database'
import { cleanupFixtures, createFixture, type Fixture } from './harness.js'
import { useRetentionDatabase, withMainDatabase } from './retention-database.js'

// purgeOldLogs deletes every old row in its table, so this file runs on its own database.
useRetentionDatabase()

afterAll(async () => {
  await cleanupFixtures()
})

const toolCall = (fx: Fixture, patch: Partial<LogEvent> = {}): LogEvent => ({
  id: randomUUID(),
  kind: 'TOOL_CALL',
  projectId: fx.projectId,
  apiKeyId: fx.apiKeyId,
  toolId: fx.toolIds['listPets']!,
  toolName: 'listPets',
  input: {},
  upstreamStatus: 200,
  latencyMs: 31,
  success: true,
  errorClass: null,
  errorMessage: null,
  responseBytes: 128,
  timestamp: Date.now() - 5_000,
  ...patch,
})

const rowsOf = (ids: string[]) => db.toolCallLog.findMany({ where: { id: { in: ids } }, orderBy: { id: 'asc' } })

describe('purgeOldLogs (used by both sink modes)', () => {
  const DAY = 24 * 60 * 60 * 1000

  it('deletes rows older than the cutoff and keeps the rest', async () => {
    const fx = await createFixture()
    const old = toolCall(fx, { timestamp: Date.now() - 40 * DAY })
    const edge = toolCall(fx, { timestamp: Date.now() - 29 * DAY })
    const fresh = toolCall(fx, { timestamp: Date.now() - 1_000 })
    await writeLogBatch(db, [old, edge, fresh])

    const deleted = await purgeOldLogs(db, { days: 30 })

    expect(deleted).toBeGreaterThanOrEqual(1)
    expect((await rowsOf([old.id, edge.id, fresh.id])).map((r) => r.id).sort()).toEqual([edge.id, fresh.id].sort())
  })

  it('works in batches and stops when nothing is left', async () => {
    const fx = await createFixture()
    const batch = Array.from({ length: 25 }, () => toolCall(fx, { timestamp: Date.now() - 90 * DAY }))
    await writeLogBatch(db, batch)

    const deleted = await purgeOldLogs(db, { days: 30, batchSize: 10 })

    expect(deleted).toBeGreaterThanOrEqual(25)
    expect(await rowsOf(batch.map((e) => e.id))).toHaveLength(0)
    expect(await purgeOldLogs(db, { days: 30, batchSize: 10 })).toBe(0)
  })

  it('stops after maxBatches and leaves the rest for the next run', async () => {
    const fx = await createFixture()
    const batch = Array.from({ length: 30 }, () => toolCall(fx, { timestamp: Date.now() - 90 * DAY }))
    await writeLogBatch(db, batch)

    await purgeOldLogs(db, { days: 30, batchSize: 5, maxBatches: 1 })
    // Other test files may have old rows of their own; what matters is that this run did not finish the job.
    expect((await rowsOf(batch.map((e) => e.id))).length).toBeGreaterThan(0)

    await purgeOldLogs(db, { days: 30 })
    expect(await rowsOf(batch.map((e) => e.id))).toHaveLength(0)
  })

  it('uses the clock it is given', async () => {
    const fx = await createFixture()
    // 25 days old: inside the 30-day period on the real clock, outside it on a clock 10 days ahead.
    // The shifted cutoff (20 days ago) reaches only rows this old, not other test files' fresh rows.
    const e = toolCall(fx, { timestamp: Date.now() - 25 * DAY })
    await writeLogBatch(db, [e])

    await purgeOldLogs(db, { days: 30 })
    expect(await rowsOf([e.id])).toHaveLength(1)
    await purgeOldLogs(db, { days: 30, now: () => Date.now() + 10 * DAY })
    expect(await rowsOf([e.id])).toHaveLength(0)
  })
})

describe('the retention tests have a database of their own', () => {
  const DAY = 24 * 60 * 60 * 1000
  const nameOf = (url: string) => decodeURIComponent(new URL(url).pathname.slice(1))

  it('runs on the retention database, not the one the rest of the gateway suite uses', async () => {
    const [row] = await db.$queryRaw<{ name: string }[]>`SELECT current_database() AS name`
    expect(row!.name).toBe(nameOf(testDatabaseUrl('gatewayretention')))
    expect(row!.name).not.toBe(nameOf(testDatabaseUrl('gateway')))
  })

  it('a purge here leaves a 100-day-old row in the main gateway database alone', async () => {
    const rowId = randomUUID()
    let userId = ''
    await withMainDatabase(async () => {
      const user = await db.user.create({ data: { email: `isolation-${rowId}@test.local`, name: 'Isolation' } })
      userId = user.id
      const project = await db.project.create({ data: { userId, name: 'Isolation', slug: `iso-${rowId.slice(0, 8)}`, upstreamBaseUrl: '' } })
      await writeLogBatch(db, [
        {
          id: rowId,
          kind: 'TOOL_CALL',
          projectId: project.id,
          apiKeyId: null,
          toolId: null,
          toolName: 'listPets',
          input: {},
          upstreamStatus: 200,
          latencyMs: 5,
          success: true,
          errorClass: null,
          errorMessage: null,
          responseBytes: 1,
          timestamp: Date.now() - 100 * DAY,
        },
      ])
    })
    try {
      await purgeOldLogs(db, { days: 30 }) // on the retention database: everything old that is there goes
      expect(await withMainDatabase(() => db.toolCallLog.count({ where: { id: rowId } }))).toBe(1)
    } finally {
      await withMainDatabase(() => db.user.deleteMany({ where: { id: userId } })) // projects and logs cascade
    }
  })
})
