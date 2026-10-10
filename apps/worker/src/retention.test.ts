import { randomUUID } from 'node:crypto'
import { db, writeLogBatch } from '@mcp-gateway/db'
import type { LogEvent } from '@mcp-gateway/shared'
import { Queue } from 'bullmq'
import { Redis } from 'ioredis'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { RETENTION_SCHEDULER_ID, startRetention } from './retention.js'

const REDIS_URL = process.env['REDIS_URL_TEST'] ?? 'redis://localhost:6379/1'
const DAY = 24 * 60 * 60 * 1000

let userId: string
let projectId: string
let connection: Redis

beforeAll(async () => {
  userId = (await db.user.create({ data: { email: `retention-${randomUUID()}@test.local` } })).id
  projectId = (await db.project.create({ data: { userId, name: 'Retention test', slug: `rt-${randomUUID().slice(0, 12)}`, upstreamBaseUrl: '' } })).id
  connection = new Redis(REDIS_URL, { maxRetriesPerRequest: null })
})
afterAll(async () => {
  await db.user.delete({ where: { id: userId } })
  connection.disconnect()
  await db.$disconnect()
})

const event = (ageDays: number): LogEvent => ({
  id: randomUUID(),
  kind: 'TOOL_CALL',
  projectId,
  apiKeyId: null,
  toolId: null,
  toolName: 'listPets',
  input: {},
  upstreamStatus: 200,
  latencyMs: 5,
  success: true,
  errorClass: null,
  errorMessage: null,
  responseBytes: 10,
  timestamp: Date.now() - ageDays * DAY,
})
const count = (id: string) => db.toolCallLog.count({ where: { id } })

describe('worker retention (queue mode)', () => {
  it('deletes rows older than the retention period on a schedule, and keeps newer ones', async () => {
    const queueName = `test-maintenance-${randomUUID()}`
    const old = event(45)
    const fresh = event(2)
    await writeLogBatch(db, [old, fresh])

    const retention = await startRetention(db, connection, { days: 30, everyMs: 200, firstRunDelayMs: 20, queueName })
    const inspector = new Queue(queueName, { connection })
    try {
      await vi.waitFor(async () => expect(await count(old.id)).toBe(0), { timeout: 8_000, interval: 100 })
      expect(await count(fresh.id)).toBe(1)

      // It keeps running: a row that becomes eligible later is deleted by a later run.
      const later = event(60)
      await writeLogBatch(db, [later])
      await vi.waitFor(async () => expect(await count(later.id)).toBe(0), { timeout: 8_000, interval: 100 })
    } finally {
      await retention.close()
      await inspector.obliterate({ force: true }).catch(() => undefined)
      await inspector.close()
    }
  })

  it('purges once shortly after boot, without waiting a whole interval', async () => {
    const queueName = `test-maintenance-${randomUUID()}`
    const old = event(45)
    await writeLogBatch(db, [old])

    // The interval is an hour: only the first run, a moment after boot, can delete the row in time.
    const retention = await startRetention(db, connection, { days: 30, everyMs: 3_600_000, firstRunDelayMs: 50, queueName })
    try {
      await vi.waitFor(async () => expect(await count(old.id)).toBe(0), { timeout: 8_000, interval: 100 })
    } finally {
      await retention.close()
      await new Queue(queueName, { connection }).obliterate({ force: true }).catch(() => undefined)
    }
  })

  it('does not purge the moment the worker starts (BullMQ would otherwise run the first job at once)', async () => {
    const queueName = `test-maintenance-${randomUUID()}`
    const old = event(45)
    await writeLogBatch(db, [old])

    const retention = await startRetention(db, connection, { days: 30, everyMs: 3_600_000, firstRunDelayMs: 3_600_000, queueName })
    try {
      await new Promise((r) => setTimeout(r, 600))
      expect(await count(old.id)).toBe(1)
    } finally {
      await retention.close()
      await new Queue(queueName, { connection }).obliterate({ force: true }).catch(() => undefined)
      await db.toolCallLog.delete({ where: { id: old.id } })
    }
  })

  it('uses the configured number of days', async () => {
    const queueName = `test-maintenance-${randomUUID()}`
    const tenDays = event(10)
    await writeLogBatch(db, [tenDays])

    const retention = await startRetention(db, connection, { days: 7, everyMs: 200, firstRunDelayMs: 20, queueName })
    try {
      await vi.waitFor(async () => expect(await count(tenDays.id)).toBe(0), { timeout: 8_000, interval: 100 })
    } finally {
      await retention.close()
      await new Queue(queueName, { connection }).obliterate({ force: true }).catch(() => undefined)
    }
  })

  it('keeps one schedule however many times the worker starts', async () => {
    const queueName = `test-maintenance-${randomUUID()}`
    const first = await startRetention(db, connection, { days: 30, everyMs: 3_600_000, queueName })
    const second = await startRetention(db, connection, { days: 30, everyMs: 3_600_000, queueName })
    const inspector = new Queue(queueName, { connection })
    try {
      const schedulers = await inspector.getJobSchedulers()
      expect(schedulers.map((s) => s.key)).toEqual([RETENTION_SCHEDULER_ID])
    } finally {
      await first.close()
      await second.close()
      await inspector.obliterate({ force: true }).catch(() => undefined)
      await inspector.close()
    }
  })
})
