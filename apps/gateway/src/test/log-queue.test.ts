import { randomUUID } from 'node:crypto'
import { db } from '@mcp-gateway/db'
import type { LogEvent } from '@mcp-gateway/shared'
import { Queue } from 'bullmq'
import { Redis } from 'ioredis'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { BufferedLogSink } from '../logging/index.js'
import { createQueueWriter } from '../logging/queue.js'
import { cleanupFixtures, createFixture, rpc, startGateway, startUpstream, type MockUpstream } from './harness.js'
import { scenarios, scenarioUpstream, secretForms } from './log-scenarios.js'

const REDIS_URL = process.env['REDIS_URL_TEST'] ?? 'redis://localhost:6379/1'
const silent = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }

let upstream: MockUpstream
let reader: Redis

beforeAll(async () => {
  vi.stubEnv('NODE_ENV', 'development')
  vi.stubEnv('ALLOW_PRIVATE_UPSTREAMS', 'true')
  upstream = await startUpstream((req, res) => scenarioUpstream(req, res))
  reader = new Redis(REDIS_URL, { maxRetriesPerRequest: null })
})

afterAll(async () => {
  await upstream.close()
  reader.disconnect()
  await cleanupFixtures()
  vi.unstubAllEnvs()
})

/** A queue-mode sink on a queue of its own, so no worker (a real one, or another test's) can take the jobs. */
async function queueSink(overrides: Partial<ConstructorParameters<typeof BufferedLogSink>[0]> = {}) {
  const name = `test-logs-${randomUUID()}`
  const queue = await createQueueWriter(REDIS_URL, silent, name)
  const sink = new BufferedLogSink({
    writer: queue.writer,
    dispose: queue.dispose,
    log: silent,
    maxBuffer: 1_000,
    batchSize: 100,
    flushIntervalMs: 3_600_000,
    shutdownFlushMs: 2_000,
    ...overrides,
  })
  const inspector = new Queue<{ events: LogEvent[] }>(name, { connection: reader })
  const jobs = async () => (await inspector.getJobs(['waiting', 'delayed', 'active', 'prioritized'])).filter((j) => j !== undefined)
  const payloadEvents = async () => (await jobs()).flatMap((j) => j.data.events)
  const cleanup = async () => {
    await inspector.obliterate({ force: true }).catch(() => undefined)
    await inspector.close()
  }
  return { sink, name, jobs, payloadEvents, cleanup }
}

describe('queue mode', () => {
  it('sends a batch of calls as one job', async () => {
    const q = await queueSink()
    const logging = await startGateway({ logSink: q.sink })
    try {
      const own = await createFixture({ upstreamBaseUrl: upstream.url })
      for (let i = 0; i < 5; i++) await rpc(logging.mcpUrl(own.slug), own.apiKey, 'tools/call', { name: 'listPets', arguments: { limit: i } })
      await q.sink.flush(true)

      const jobs = await q.jobs()
      expect(jobs).toHaveLength(1)
      expect(jobs[0]!.data.events).toHaveLength(5)
      expect(jobs[0]!.data.events.map((e) => e.input)).toEqual([{ limit: 0 }, { limit: 1 }, { limit: 2 }, { limit: 3 }, { limit: 4 }])
      expect(jobs[0]!.opts.attempts).toBe(5)
    } finally {
      await logging.close()
      await q.cleanup()
    }
  })

  it('splits a bigger backlog into batches of at most batchSize', async () => {
    const q = await queueSink({ batchSize: 10 })
    const logging = await startGateway({ logSink: q.sink })
    try {
      const own = await createFixture({ upstreamBaseUrl: upstream.url })
      for (let i = 0; i < 25; i++) await rpc(logging.mcpUrl(own.slug), own.apiKey, 'tools/call', { name: 'listPets', arguments: {} })
      await q.sink.flush(true)

      const sizes = (await q.jobs()).map((j) => j.data.events.length).sort((a, b) => b - a)
      expect(sizes).toEqual([10, 10, 5])
    } finally {
      await logging.close()
      await q.cleanup()
    }
  })

  it('flushes on shutdown: events buffered when the app closes are in the queue afterwards', async () => {
    const q = await queueSink({ batchSize: 1_000 })
    const logging = await startGateway({ logSink: q.sink })
    const own = await createFixture({ upstreamBaseUrl: upstream.url })
    for (let i = 0; i < 4; i++) await rpc(logging.mcpUrl(own.slug), own.apiKey, 'tools/call', { name: 'listPets', arguments: {} })
    await logging.close() // closes the sink, which flushes and then closes its connection

    const check = new Queue<{ events: LogEvent[] }>(q.name, { connection: reader })
    try {
      const events = (await check.getJobs(['waiting', 'delayed'])).flatMap((j) => j.data.events)
      expect(events).toHaveLength(4)
    } finally {
      await check.obliterate({ force: true })
      await check.close()
    }
  })

  it('a Redis outage does not fail calls; events wait in the buffer and are not lost', async () => {
    const name = `test-logs-${randomUUID()}`
    const dead = await createQueueWriter('redis://127.0.0.1:1', silent, name)
    const sink = new BufferedLogSink({ writer: dead.writer, dispose: dead.dispose, log: silent, maxBuffer: 1_000, batchSize: 1, flushIntervalMs: 50, shutdownFlushMs: 100, writeTimeoutMs: 200 })
    const logging = await startGateway({ logSink: sink })
    try {
      const own = await createFixture({ upstreamBaseUrl: upstream.url })
      for (let i = 0; i < 5; i++) expect((await rpc(logging.mcpUrl(own.slug), own.apiKey, 'tools/call', { name: 'listPets', arguments: {} })).status).toBe(200)
      // Nothing was written or lost. One event may be inside a failing write rather than in the buffer.
      await vi.waitFor(() => expect(sink.stats().consecutiveFailures).toBeGreaterThan(0), { timeout: 5_000 })
      expect(sink.stats().buffered).toBeGreaterThanOrEqual(4)
      expect(sink.stats()).toMatchObject({ written: 0, dropped: 0 })
    } finally {
      await logging.close()
    }
  })

  it('the queued events are what the worker needs: they pass the event schema and carry their ids', async () => {
    const q = await queueSink()
    const logging = await startGateway({ logSink: q.sink })
    try {
      const own = await createFixture({ upstreamBaseUrl: upstream.url })
      await rpc(logging.mcpUrl(own.slug), own.apiKey, 'tools/call', { name: 'getPet', arguments: { petId: 404 } })
      await q.sink.flush(true)

      const [event] = await q.payloadEvents()
      expect(event).toMatchObject({ projectId: own.projectId, toolName: 'getPet', errorClass: 'UPSTREAM_4XX', upstreamStatus: 404 })
      expect(event!.id).toMatch(/^[0-9a-f-]{36}$/)
      expect(await db.toolCallLog.count({ where: { projectId: own.projectId } })).toBe(0) // the gateway itself writes nothing in queue mode
    } finally {
      await logging.close()
      await q.cleanup()
    }
  })
})

describe('the credential never reaches the queue', () => {
  it.each(scenarios)('$name', async (scenario) => {
    const q = await queueSink()
    const logging = await startGateway({ logSink: q.sink, config: { toolTimeoutMs: 400 } })
    try {
      const own = await scenario.run({ upstreamUrl: upstream.url, gateway: logging })
      await q.sink.flush(true)

      // The raw job data as stored in Redis, not just the parsed object.
      const raw = JSON.stringify((await q.jobs()).map((j) => j.asJSON()))
      expect(raw.length).toBeGreaterThan(0)
      expect((await q.payloadEvents()).some((e) => e.projectId === own.projectId)).toBe(true)
      for (const form of secretForms()) expect(raw, `queue payload contains ${form}`).not.toContain(form)
    } finally {
      await logging.close()
      await q.cleanup()
    }
  })
})
