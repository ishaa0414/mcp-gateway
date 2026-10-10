import { db, writeLogBatch } from '@mcp-gateway/db'
import { hashApiKey } from '@mcp-gateway/crypto'
import type { LogEvent } from '@mcp-gateway/shared'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { BufferedLogSink } from '../logging/index.js'
import {
  addApiKey,
  CollectingSink,
  cleanupFixtures,
  createFixture,
  rpc,
  startGateway,
  startUpstream,
  type Fixture,
  type MockUpstream,
  type RunningGateway,
} from './harness.js'
import { scenarios, scenarioUpstream, secretForms } from './log-scenarios.js'

const silent = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }

/** A sink that writes to Postgres like direct mode would, and keeps every batch it was handed. */
function databaseSink(overrides: Partial<ConstructorParameters<typeof BufferedLogSink>[0]> = {}) {
  const batches: LogEvent[][] = []
  const sink = new BufferedLogSink({
    writer: async (batch) => {
      batches.push(batch)
      await writeLogBatch(db, batch)
    },
    log: silent,
    maxBuffer: 1_000,
    batchSize: 100,
    flushIntervalMs: 3_600_000, // tests flush by hand
    shutdownFlushMs: 2_000,
    ...overrides,
  })
  return { sink, batches }
}

let upstream: MockUpstream
let events: CollectingSink
let gateway: RunningGateway

beforeAll(async () => {
  vi.stubEnv('NODE_ENV', 'development')
  vi.stubEnv('ALLOW_PRIVATE_UPSTREAMS', 'true')
  upstream = await startUpstream((req, res) => scenarioUpstream(req, res))
  events = new CollectingSink()
  gateway = await startGateway({ logSink: events, config: { toolTimeoutMs: 400 } })
})

afterAll(async () => {
  await gateway.close()
  await upstream.close()
  await cleanupFixtures()
  vi.unstubAllEnvs()
})

const call = (f: Fixture, name: string, args: object = {}, gw = gateway) => rpc(gw.mcpUrl(f.slug), f.apiKey, 'tools/call', { name, arguments: args })
const eventsOf = (f: Fixture) => events.events.filter((e) => e.projectId === f.projectId)

describe('a log event for every tool call', () => {
  it('records who, what, how long and how it ended', async () => {
    const own = await createFixture({ upstreamBaseUrl: upstream.url })
    await call(own, 'listPets', { limit: 3 })

    const [e, ...rest] = eventsOf(own)
    expect(rest).toHaveLength(0)
    expect(e).toMatchObject({
      kind: 'TOOL_CALL',
      projectId: own.projectId,
      apiKeyId: own.apiKeyId,
      toolId: own.toolIds['listPets'],
      toolName: 'listPets',
      input: { limit: 3 },
      upstreamStatus: 200,
      success: true,
      errorClass: null,
      errorMessage: null,
    })
    expect(e!.latencyMs).toBeGreaterThanOrEqual(0)
    expect(e!.responseBytes).toBeGreaterThan(0)
    expect(Math.abs(e!.timestamp - Date.now())).toBeLessThan(10_000)
  })

  it('records the size of the response, not the response', async () => {
    const own = await createFixture({ upstreamBaseUrl: upstream.url })
    await call(own, 'listPets')
    const [e] = eventsOf(own)
    expect(e!.responseBytes).toBe(Buffer.byteLength(JSON.stringify({ pets: [], echoedUrl: '/pets' })))
    expect(JSON.stringify(e)).not.toContain('echoedUrl')
  })

  it.each(scenarios)('$name', async (scenario) => {
    const own = await scenario.run({ upstreamUrl: upstream.url, gateway })
    const logged = eventsOf(own)

    expect(logged.length).toBeGreaterThan(0)
    const last = logged[logged.length - 1]!
    if (scenario.errorClass === null) {
      expect(last).toMatchObject({ success: true, errorClass: null })
    } else {
      expect(last).toMatchObject({ success: false, errorClass: scenario.errorClass })
    }
  })

  it('classifies upstream statuses and keeps the status', async () => {
    const own = await createFixture({ upstreamBaseUrl: upstream.url })
    await call(own, 'getPet', { petId: 404 })
    await call(own, 'getPet', { petId: 500 })
    expect(eventsOf(own).map((e) => [e.errorClass, e.upstreamStatus])).toEqual([
      ['UPSTREAM_4XX', 404],
      ['UPSTREAM_5XX', 500],
    ])
  })

  it('does not log requests that are not tool calls', async () => {
    const own = await createFixture({ upstreamBaseUrl: upstream.url })
    await rpc(gateway.mcpUrl(own.slug), own.apiKey, 'tools/list')
    await rpc(gateway.mcpUrl(own.slug), own.apiKey, 'initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '1' } })
    expect(eventsOf(own)).toHaveLength(0)
  })
})

describe('what is stored for the arguments', () => {
  it('masks sensitive values and credential-shaped text', async () => {
    const own = await createFixture({ upstreamBaseUrl: upstream.url })
    await call(own, 'createPet', { name: 'Rex Bearer abcdef123456', tag: 'mcpg_aaaaaaaaaaaaaaaaaaaa' })
    const [e] = eventsOf(own)
    expect(e!.input).toEqual({ name: 'Rex [MASKED]', tag: '[MASKED]' })
  })

  it('never contains hidden parameter values or the upstream credential', async () => {
    const own = await createFixture({
      upstreamBaseUrl: upstream.url,
      hidden: { createPet: { tag: { value: 'hidden-fixed-value-123' } } },
      credential: { type: 'BEARER', value: 'bearer-secret-7788' },
    })
    await call(own, 'createPet', { name: 'Rex' })
    const json = JSON.stringify(eventsOf(own))
    expect(json).not.toContain('hidden-fixed-value-123')
    expect(json).not.toContain('bearer-secret-7788')
    expect(eventsOf(own)[0]!.input).toEqual({ name: 'Rex' })
  })

  it('keeps a huge argument small', async () => {
    const own = await createFixture({ upstreamBaseUrl: upstream.url })
    await call(own, 'createPet', { name: 'x'.repeat(500_000) })
    const [e] = eventsOf(own)
    expect(JSON.stringify(e).length).toBeLessThan(2_000)
  })
})

describe('the credential never reaches a stored row or a queued payload', () => {
  it.each(scenarios)('$name', async (scenario) => {
    const { sink, batches } = databaseSink()
    const logging = await startGateway({ logSink: sink, config: { toolTimeoutMs: 400 } })
    try {
      const own = await scenario.run({ upstreamUrl: upstream.url, gateway: logging })
      await sink.flush(true)

      const rows = await db.toolCallLog.findMany({ where: { projectId: own.projectId } })
      expect(rows.length).toBeGreaterThan(0)
      const stored = JSON.stringify(rows)
      const payload = JSON.stringify(batches)

      for (const form of secretForms()) {
        expect(stored, `row contains ${form}`).not.toContain(form)
        expect(payload, `payload contains ${form}`).not.toContain(form)
      }
      for (const row of rows) {
        // No URL, no query string, no redirect target in any stored message.
        expect(row.errorMessage ?? '').not.toMatch(/:\/\/|\?|\/elsewhere/)
        expect(JSON.stringify(row.input)).not.toContain('api_key')
      }
    } finally {
      await logging.close()
    }
  })
})

describe('auth failures', () => {
  const failures = () => events.events.filter((e) => e.kind === 'AUTH_FAILURE')

  it('are logged under the URL’s project without the key, its hash or any prefix of it', async () => {
    const own = await createFixture({ upstreamBaseUrl: upstream.url })
    const bad = 'mcpg_this-key-was-never-issued-0123456789'
    const before = failures().length

    const res = await rpc(gateway.mcpUrl(own.slug), bad, 'tools/list')
    expect(res.status).toBe(401)

    const [e] = failures().slice(before)
    expect(e).toMatchObject({ kind: 'AUTH_FAILURE', projectSlug: own.slug, apiKeyId: null, toolId: null, toolName: null, input: {}, success: false, errorClass: 'AUTH_INVALID' })
    const serialised = JSON.stringify(e)
    expect(serialised).not.toContain(bad)
    expect(serialised).not.toContain(hashApiKey(bad))
    expect(serialised).not.toContain(bad.slice(0, 10))
  })

  it('tell a missing key from an invalid one and from another project’s key', async () => {
    const mine = await createFixture({ upstreamBaseUrl: upstream.url })
    const theirs = await createFixture({ upstreamBaseUrl: upstream.url })
    const before = failures().length

    await rpc(gateway.mcpUrl(mine.slug), undefined, 'tools/list')
    await rpc(gateway.mcpUrl(mine.slug), 'mcpg_this-key-was-never-issued-0123456789', 'tools/list')
    const cross = await rpc(gateway.mcpUrl(mine.slug), theirs.apiKey, 'tools/list')
    expect(cross.status).toBe(401)

    const logged = failures().slice(before).filter((e) => e.projectSlug === mine.slug)
    expect(logged.map((e) => e.errorClass).sort()).toEqual(['AUTH_INVALID', 'AUTH_MISSING', 'AUTH_WRONG_PROJECT'])
    // The other tenant's key is nowhere in the row that is filed under this project.
    expect(JSON.stringify(logged)).not.toContain(theirs.apiKeyId)
    expect(JSON.stringify(logged)).not.toContain(theirs.apiKey)
    expect(logged.every((e) => e.apiKeyId === null)).toBe(true)
  })

  it('are sampled: a flood of bad requests logs one row per reason, not thousands', async () => {
    const own = await createFixture({ upstreamBaseUrl: upstream.url })
    const before = failures().length

    await Promise.all(Array.from({ length: 60 }, () => rpc(gateway.mcpUrl(own.slug), 'mcpg_this-key-was-never-issued-0123456789', 'tools/list')))

    expect(failures().slice(before).filter((e) => e.projectSlug === own.slug)).toHaveLength(1)
  })

  it('are not logged for a project slug that cannot exist', async () => {
    const before = events.events.length
    await rpc(gateway.mcpUrl('NOT A SLUG!'), 'mcpg_this-key-was-never-issued-0123456789', 'tools/list').catch(() => undefined)
    expect(events.events.length).toBe(before)
  })

  it('reach Postgres under the right project, and are dropped for an unknown slug', async () => {
    const { sink } = databaseSink()
    const logging = await startGateway({ logSink: sink })
    try {
      const own = await createFixture({ upstreamBaseUrl: upstream.url })
      await rpc(logging.mcpUrl(own.slug), 'mcpg_this-key-was-never-issued-0123456789', 'tools/list')
      await rpc(logging.mcpUrl('valid-looking-but-unknown-project'), 'mcpg_this-key-was-never-issued-0123456789', 'tools/list')
      await sink.flush(true)

      const rows = await db.toolCallLog.findMany({ where: { projectId: own.projectId } })
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({ kind: 'AUTH_FAILURE', errorClass: 'AUTH_INVALID', apiKeyId: null, toolId: null })
    } finally {
      await logging.close()
    }
  })
})

describe('rate-limited calls', () => {
  it('are logged once per key per interval, with RATE_LIMITED and no latency', async () => {
    const own = await createFixture({ upstreamBaseUrl: upstream.url })
    const limited = await addApiKey(own.projectId, false, 1)
    const callWith = (key: string) => rpc(gateway.mcpUrl(own.slug), key, 'tools/call', { name: 'createPet', arguments: { name: 'Rex', password: 'hunter2' } })

    await callWith(limited.key)
    for (let i = 0; i < 25; i++) expect((await callWith(limited.key)).status).toBe(429)

    const rejected = eventsOf(own).filter((e) => e.errorClass === 'RATE_LIMITED')
    expect(rejected).toHaveLength(1)
    expect(rejected[0]).toMatchObject({
      apiKeyId: limited.id,
      toolName: 'createPet',
      input: { name: 'Rex', password: '[MASKED]' },
      latencyMs: 0,
      success: false,
      upstreamStatus: null,
    })
  })
})

describe('logging never fails or slows a call', () => {
  it('a sink that throws on every event does not affect the call', async () => {
    const exploding = new CollectingSink()
    exploding.enqueue = () => {
      throw new Error('sink exploded')
    }
    const logging = await startGateway({ logSink: exploding })
    try {
      const own = await createFixture({ upstreamBaseUrl: upstream.url })
      const res = await call(own, 'listPets', {}, logging)
      expect(res.status).toBe(200)
      expect(res.body['result'].isError).toBeUndefined()
    } finally {
      await logging.close()
    }
  })

  it('a database that rejects every write does not affect calls, and nothing blocks', async () => {
    const attempts = vi.fn()
    const sink = new BufferedLogSink({
      writer: async () => {
        attempts()
        throw new Error('postgres is down')
      },
      log: silent,
      maxBuffer: 1_000,
      batchSize: 1, // every event tries to write at once
      flushIntervalMs: 50,
      shutdownFlushMs: 200,
    })
    const logging = await startGateway({ logSink: sink })
    try {
      const own = await createFixture({ upstreamBaseUrl: upstream.url })
      const started = performance.now()
      const results = await Promise.all(Array.from({ length: 20 }, () => call(own, 'listPets', {}, logging)))

      expect(results.every((r) => r.status === 200 && r.body['result'].isError === undefined)).toBe(true)
      expect(attempts).toHaveBeenCalled()
      expect(sink.stats().buffered).toBeGreaterThan(0) // kept for a retry, not lost
      expect(performance.now() - started).toBeLessThan(10_000)
    } finally {
      await logging.close()
    }
  })

  it('a full buffer drops events and the calls still succeed', async () => {
    const sink = new BufferedLogSink({
      writer: () => new Promise(() => undefined), // never completes
      log: silent,
      maxBuffer: 3,
      batchSize: 3,
      flushIntervalMs: 3_600_000,
      shutdownFlushMs: 100,
    })
    const logging = await startGateway({ logSink: sink })
    try {
      const own = await createFixture({ upstreamBaseUrl: upstream.url })
      for (let i = 0; i < 12; i++) expect((await call(own, 'listPets', {}, logging)).status).toBe(200)
      expect(sink.stats().buffered).toBeLessThanOrEqual(3)
      expect(sink.stats().dropped).toBeGreaterThan(0)
    } finally {
      await logging.close()
    }
  })
})

describe('shutdown', () => {
  it('writes what is still buffered when the app closes, before the connections go away', async () => {
    const { sink } = databaseSink({ flushIntervalMs: 3_600_000, batchSize: 1_000 })
    const logging = await startGateway({ logSink: sink })
    const own = await createFixture({ upstreamBaseUrl: upstream.url })
    for (let i = 0; i < 7; i++) await call(own, 'listPets', {}, logging)

    expect(await db.toolCallLog.count({ where: { projectId: own.projectId } })).toBe(0) // still only in memory
    await logging.close()

    expect(await db.toolCallLog.count({ where: { projectId: own.projectId } })).toBe(7)
  })

  it('closes the sink exactly when the app closes', async () => {
    const collecting = new CollectingSink()
    const logging = await startGateway({ logSink: collecting })
    expect(collecting.closed).toBe(false)
    await logging.close()
    expect(collecting.closed).toBe(true)
  })
})

describe('tenant scoping', () => {
  it('files each project’s calls under that project only', async () => {
    const { sink } = databaseSink()
    const logging = await startGateway({ logSink: sink })
    try {
      const one = await createFixture({ upstreamBaseUrl: upstream.url })
      const two = await createFixture({ upstreamBaseUrl: upstream.url })
      await call(one, 'listPets', {}, logging)
      await call(one, 'listPets', {}, logging)
      await call(two, 'getPet', { petId: 404 }, logging)
      await sink.flush(true)

      const rowsOne = await db.toolCallLog.findMany({ where: { projectId: one.projectId } })
      const rowsTwo = await db.toolCallLog.findMany({ where: { projectId: two.projectId } })
      expect(rowsOne).toHaveLength(2)
      expect(rowsOne.every((r) => r.apiKeyId === one.apiKeyId && r.toolId === one.toolIds['listPets'])).toBe(true)
      expect(rowsTwo).toHaveLength(1)
      expect(rowsTwo[0]).toMatchObject({ apiKeyId: two.apiKeyId, toolId: two.toolIds['getPet'], errorClass: 'UPSTREAM_4XX' })
    } finally {
      await logging.close()
    }
  })

  it('a key used against another project’s URL creates no tool call in either project', async () => {
    const one = await createFixture({ upstreamBaseUrl: upstream.url })
    const two = await createFixture({ upstreamBaseUrl: upstream.url })

    const res = await rpc(gateway.mcpUrl(two.slug), one.apiKey, 'tools/call', { name: 'listPets', arguments: {} })

    expect(res.status).toBe(401)
    expect(events.events.filter((e) => e.kind === 'TOOL_CALL' && (e.projectId === one.projectId || e.projectId === two.projectId))).toHaveLength(0)
  })
})
