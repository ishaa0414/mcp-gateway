import { randomUUID } from 'node:crypto'
import { db, writeLogBatch, type PrismaClient } from '@mcp-gateway/db'
import type { LogEvent } from '@mcp-gateway/shared'
import { Redis } from 'ioredis'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createLogSink, type LogSettings } from '../logging/index.js'
import { startRetention } from '../logging/retention.js'
import { cleanupFixtures, createFixture, rpc, startGateway, startUpstream, json, type MockUpstream } from './harness.js'

const REDIS_URL = process.env['REDIS_URL_TEST'] ?? 'redis://localhost:6379/1'
const log = () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() })
const DAY = 24 * 60 * 60 * 1000

const settings = (overrides: Partial<LogSettings> = {}): LogSettings => ({
  sink: 'direct',
  redisUrl: REDIS_URL,
  bufferMax: 1_000,
  batchSize: 100,
  flushIntervalMs: 100,
  shutdownFlushMs: 2_000,
  retentionDays: 30,
  retentionTiming: { firstRunDelayMs: 3_600_000, intervalMs: 3_600_000 }, // effectively never, unless a test asks
  ...overrides,
})

let upstream: MockUpstream
let reader: Redis

beforeAll(async () => {
  vi.stubEnv('NODE_ENV', 'development')
  vi.stubEnv('ALLOW_PRIVATE_UPSTREAMS', 'true')
  upstream = await startUpstream((_req, res) => json(res, { pets: [] }))
  reader = new Redis(REDIS_URL)
})
afterAll(async () => {
  await upstream.close()
  reader.disconnect()
  await cleanupFixtures()
  vi.unstubAllEnvs()
})

const event = (projectId: string, patch: Partial<LogEvent> = {}): LogEvent => ({
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
  timestamp: Date.now(),
  ...patch,
})

describe('direct mode (no worker)', () => {
  it('writes every call to Postgres within a flush interval, with nothing consuming a queue', async () => {
    const sink = await createLogSink(settings(), { log: log(), db })
    const logging = await startGateway({ logSink: sink })
    try {
      const own = await createFixture({ upstreamBaseUrl: upstream.url })
      for (let i = 0; i < 6; i++) await rpc(logging.mcpUrl(own.slug), own.apiKey, 'tools/call', { name: 'listPets', arguments: { limit: i } })
      await rpc(logging.mcpUrl(own.slug), 'mcpg_this-key-was-never-issued-0123456789', 'tools/list')

      await vi.waitFor(async () => expect(await db.toolCallLog.count({ where: { projectId: own.projectId } })).toBe(7), { timeout: 5_000, interval: 50 })
      const rows = await db.toolCallLog.findMany({ where: { projectId: own.projectId }, orderBy: { createdAt: 'asc' } })
      expect(rows.filter((r) => r.kind === 'TOOL_CALL')).toHaveLength(6)
      expect(rows.filter((r) => r.kind === 'AUTH_FAILURE')).toHaveLength(1)
      expect(rows[0]).toMatchObject({ projectId: own.projectId, apiKeyId: own.apiKeyId, toolId: own.toolIds['listPets'], toolName: 'listPets', success: true, upstreamStatus: 200 })
    } finally {
      await logging.close()
    }
  })

  it('does not use BullMQ at all: no queue keys appear in Redis', async () => {
    const before = (await reader.keys('bull:tool-call-logs:*')).length
    const sink = await createLogSink(settings(), { log: log(), db })
    const logging = await startGateway({ logSink: sink })
    try {
      const own = await createFixture({ upstreamBaseUrl: upstream.url })
      await rpc(logging.mcpUrl(own.slug), own.apiKey, 'tools/call', { name: 'listPets', arguments: {} })
      await sink.flush(true)
    } finally {
      await logging.close()
    }
    expect((await reader.keys('bull:tool-call-logs:*')).length).toBe(before)
  })

  it('writes what is still buffered when the app closes, before Postgres is disconnected', async () => {
    const sink = await createLogSink(settings({ flushIntervalMs: 3_600_000, batchSize: 1_000 }), { log: log(), db })
    const logging = await startGateway({ logSink: sink })
    const own = await createFixture({ upstreamBaseUrl: upstream.url })
    for (let i = 0; i < 9; i++) await rpc(logging.mcpUrl(own.slug), own.apiKey, 'tools/call', { name: 'listPets', arguments: {} })
    expect(await db.toolCallLog.count({ where: { projectId: own.projectId } })).toBe(0)

    await logging.close()

    expect(await db.toolCallLog.count({ where: { projectId: own.projectId } })).toBe(9)
  })

  it('has a size cap: with a database that never answers, the buffer stops at the cap and drops are counted', async () => {
    const hung = new Proxy(db, {
      get(target, prop, receiver) {
        if (prop === 'project') return { findMany: () => new Promise(() => undefined) }
        return Reflect.get(target, prop, receiver)
      },
    }) as PrismaClient
    const logger = log()
    const sink = await createLogSink(settings({ bufferMax: 10, batchSize: 5, shutdownFlushMs: 100 }), { log: logger, db: hung })
    const logging = await startGateway({ logSink: sink })
    try {
      const own = await createFixture({ upstreamBaseUrl: upstream.url })
      for (let i = 0; i < 40; i++) expect((await rpc(logging.mcpUrl(own.slug), own.apiKey, 'tools/call', { name: 'listPets', arguments: {} })).status).toBe(200)

      const stats = sink.stats()
      expect(stats.buffered).toBeLessThanOrEqual(10)
      expect(stats.dropped).toBeGreaterThan(0)
      expect(stats.written).toBe(0)
      expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({ dropped: expect.any(Number) }), 'call log buffer is full: events dropped')
    } finally {
      await logging.close()
    }
  })

  it('keeps events through a database outage and writes them when it returns', async () => {
    let down = true
    const flaky = new Proxy(db, {
      get(target, prop, receiver) {
        if (prop === 'project' && down) return { findMany: () => Promise.reject(new Error('postgres is down')) }
        return Reflect.get(target, prop, receiver)
      },
    }) as PrismaClient
    const sink = await createLogSink(settings({ flushIntervalMs: 50 }), { log: log(), db: flaky })
    const logging = await startGateway({ logSink: sink })
    try {
      const own = await createFixture({ upstreamBaseUrl: upstream.url })
      for (let i = 0; i < 4; i++) await rpc(logging.mcpUrl(own.slug), own.apiKey, 'tools/call', { name: 'listPets', arguments: {} })
      await vi.waitFor(() => expect(sink.stats().consecutiveFailures).toBeGreaterThan(0), { timeout: 5_000 })
      expect(await db.toolCallLog.count({ where: { projectId: own.projectId } })).toBe(0)

      down = false
      await sink.flush(true)
      expect(await db.toolCallLog.count({ where: { projectId: own.projectId } })).toBe(4)
    } finally {
      await logging.close()
    }
  })
})

describe('retention in direct mode (the gateway deletes, no worker)', () => {
  it('deletes rows older than the retention period shortly after start, and keeps the rest', async () => {
    const own = await createFixture()
    const old = event(own.projectId, { timestamp: Date.now() - 45 * DAY })
    const fresh = event(own.projectId, { timestamp: Date.now() - DAY })
    await writeLogBatch(db, [old, fresh])

    const sink = await createLogSink(settings({ retentionTiming: { firstRunDelayMs: 20, intervalMs: 3_600_000 } }), { log: log(), db })
    try {
      await vi.waitFor(async () => expect(await db.toolCallLog.count({ where: { id: old.id } })).toBe(0), { timeout: 5_000, interval: 50 })
      expect(await db.toolCallLog.count({ where: { id: fresh.id } })).toBe(1)
    } finally {
      await sink.close()
    }
  })

  it('honours the configured number of days', async () => {
    const own = await createFixture()
    const tenDaysOld = event(own.projectId, { timestamp: Date.now() - 10 * DAY })
    await writeLogBatch(db, [tenDaysOld])

    const sink = await createLogSink(settings({ retentionDays: 7, retentionTiming: { firstRunDelayMs: 20, intervalMs: 3_600_000 } }), { log: log(), db })
    try {
      await vi.waitFor(async () => expect(await db.toolCallLog.count({ where: { id: tenDaysOld.id } })).toBe(0), { timeout: 5_000, interval: 50 })
    } finally {
      await sink.close()
    }
  })

  it('runs again on the interval, and stops when the sink is closed', async () => {
    const own = await createFixture()
    const sink = await createLogSink(settings({ retentionTiming: { firstRunDelayMs: 20, intervalMs: 100 } }), { log: log(), db })
    const later = event(own.projectId, { timestamp: Date.now() - 60 * DAY })
    await new Promise((r) => setTimeout(r, 300)) // past the first run
    await writeLogBatch(db, [later])
    try {
      await vi.waitFor(async () => expect(await db.toolCallLog.count({ where: { id: later.id } })).toBe(0), { timeout: 5_000, interval: 50 })
    } finally {
      await sink.close()
    }

    const afterClose = event(own.projectId, { timestamp: Date.now() - 60 * DAY })
    await writeLogBatch(db, [afterClose])
    await new Promise((r) => setTimeout(r, 400))
    expect(await db.toolCallLog.count({ where: { id: afterClose.id } })).toBe(1) // nothing ran after close
  })

  it('is not started in queue mode (the worker does that)', async () => {
    const own = await createFixture()
    const old = event(own.projectId, { timestamp: Date.now() - 45 * DAY })
    await writeLogBatch(db, [old])

    const sink = await createLogSink(settings({ sink: 'queue', retentionTiming: { firstRunDelayMs: 20, intervalMs: 50 } }), { log: log(), db })
    try {
      await new Promise((r) => setTimeout(r, 400))
      expect(await db.toolCallLog.count({ where: { id: old.id } })).toBe(1)
    } finally {
      await sink.close()
      await db.toolCallLog.delete({ where: { id: old.id } })
    }
  })
})

describe('startRetention', () => {
  it('logs a failed run and tries again on the next interval', async () => {
    let calls = 0
    const flaky = new Proxy(db, {
      get(target, prop, receiver) {
        if (prop === '$executeRaw') {
          return () => {
            calls++
            return calls === 1 ? Promise.reject(new Error('deadlock')) : Promise.resolve(0)
          }
        }
        return Reflect.get(target, prop, receiver)
      },
    }) as PrismaClient
    const logger = log()
    const retention = startRetention(flaky, logger, { days: 30, firstRunDelayMs: 10, intervalMs: 60 })
    try {
      await vi.waitFor(() => expect(calls).toBeGreaterThanOrEqual(2), { timeout: 5_000, interval: 20 })
      expect(logger.warn).toHaveBeenCalledWith({ err: 'deadlock' }, expect.stringContaining('will retry'))
    } finally {
      retention.stop()
    }
  })

  it('never runs two deletes at once', async () => {
    let active = 0
    let peak = 0
    const slow = new Proxy(db, {
      get(target, prop, receiver) {
        if (prop === '$executeRaw') {
          return async () => {
            peak = Math.max(peak, ++active)
            await new Promise((r) => setTimeout(r, 120))
            active--
            return 0
          }
        }
        return Reflect.get(target, prop, receiver)
      },
    }) as PrismaClient
    const retention = startRetention(slow, log(), { days: 30, firstRunDelayMs: 10, intervalMs: 20 })
    await new Promise((r) => setTimeout(r, 500))
    retention.stop()
    expect(peak).toBe(1)
  })
})
