import { randomUUID } from 'node:crypto'
import { db, purgeOldLogs, writeLogBatch } from '@mcp-gateway/db'
import type { LogEvent } from '@mcp-gateway/shared'
import { afterAll, describe, expect, it } from 'vitest'
import { cleanupFixtures, createFixture, type Fixture } from './harness.js'

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
    const e = toolCall(fx, { timestamp: Date.now() })
    await writeLogBatch(db, [e])

    await purgeOldLogs(db, { days: 30, now: () => Date.now() + 10 * DAY })
    expect(await rowsOf([e.id])).toHaveLength(1)
    await purgeOldLogs(db, { days: 30, now: () => Date.now() + 31 * DAY })
    expect(await rowsOf([e.id])).toHaveLength(0)
  })
})
