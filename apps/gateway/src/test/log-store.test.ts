import { randomUUID } from 'node:crypto'
import { db, writeLogBatch } from '@mcp-gateway/db'
import type { LogEvent } from '@mcp-gateway/shared'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { cleanupFixtures, createFixture, type Fixture } from './harness.js'

let a: Fixture
let b: Fixture

beforeAll(async () => {
  a = await createFixture()
  b = await createFixture()
})
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
  input: { limit: 5 },
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

describe('writeLogBatch', () => {
  it('uses the gateway-generated event id as the row id', async () => {
    const e = toolCall(a)
    await writeLogBatch(db, [e])

    const row = await db.toolCallLog.findUnique({ where: { id: e.id } })
    expect(row?.id).toBe(e.id)
  })

  it('stores every field of the event, and the time the call happened', async () => {
    const e = toolCall(a, { upstreamStatus: 404, success: false, errorClass: 'UPSTREAM_4XX', errorMessage: 'The upstream API returned HTTP 404 Not Found.', timestamp: 1_700_000_123_456 })
    const result = await writeLogBatch(db, [e])

    expect(result).toEqual({ written: 1, duplicates: 0, invalid: 0, unknownProject: 0 })
    expect(await db.toolCallLog.findUnique({ where: { id: e.id } })).toMatchObject({
      kind: 'TOOL_CALL',
      projectId: a.projectId,
      toolId: a.toolIds['listPets'],
      toolName: 'listPets',
      apiKeyId: a.apiKeyId,
      input: { limit: 5 },
      upstreamStatus: 404,
      latencyMs: 31,
      success: false,
      errorClass: 'UPSTREAM_4XX',
      errorMessage: 'The upstream API returned HTTP 404 Not Found.',
      responseBytes: 128,
      createdAt: new Date(1_700_000_123_456),
    })
  })

  it('stores a redelivered batch once: skipDuplicates dedupes on the event id', async () => {
    const batch = [toolCall(a), toolCall(a), toolCall(a)]

    const first = await writeLogBatch(db, batch)
    const second = await writeLogBatch(db, batch)
    // A retry may also carry events the first attempt never saw.
    const extra = toolCall(a)
    const third = await writeLogBatch(db, [...batch, extra])

    expect(first).toMatchObject({ written: 3, duplicates: 0 })
    expect(second).toMatchObject({ written: 0, duplicates: 3 })
    expect(third).toMatchObject({ written: 1, duplicates: 3 })
    expect(await rowsOf([...batch, extra].map((e) => e.id))).toHaveLength(4)
  })

  it('writes a large batch in one go', async () => {
    const batch = Array.from({ length: 500 }, () => toolCall(a))
    expect((await writeLogBatch(db, batch)).written).toBe(500)
  })

  it('resolves an auth failure from its slug, with no key and no tool', async () => {
    const e: LogEvent = {
      id: randomUUID(),
      kind: 'AUTH_FAILURE',
      projectSlug: a.slug,
      apiKeyId: null,
      toolId: null,
      toolName: null,
      input: {},
      upstreamStatus: null,
      latencyMs: 0,
      success: false,
      errorClass: 'AUTH_INVALID',
      errorMessage: null,
      responseBytes: null,
      timestamp: Date.now(),
    }
    await writeLogBatch(db, [e])

    expect(await db.toolCallLog.findUnique({ where: { id: e.id } })).toMatchObject({
      kind: 'AUTH_FAILURE',
      projectId: a.projectId,
      apiKeyId: null,
      toolId: null,
      success: false,
      errorClass: 'AUTH_INVALID',
    })
  })

  it('drops auth failures for a slug that is not a project, without failing the batch', async () => {
    const stray: LogEvent = { ...toolCall(a), projectId: undefined, projectSlug: 'no-such-project-anywhere', apiKeyId: null, toolId: null, toolName: null, kind: 'AUTH_FAILURE', errorClass: 'AUTH_INVALID', success: false } as LogEvent
    const good = toolCall(a)
    const result = await writeLogBatch(db, [stray, good])

    expect(result).toMatchObject({ written: 1, unknownProject: 1 })
    expect(await rowsOf([stray.id])).toHaveLength(0)
    expect(await rowsOf([good.id])).toHaveLength(1)
  })

  it('skips an invalid event and writes the rest', async () => {
    const good = toolCall(a)
    const bad = { ...toolCall(a), latencyMs: -5 }
    const garbage = 'not an event'
    const result = await writeLogBatch(db, [bad, garbage, good])

    expect(result).toMatchObject({ written: 1, invalid: 2 })
    expect(await rowsOf([good.id])).toHaveLength(1)
    expect(await rowsOf([bad.id])).toHaveLength(0)
  })

  it('handles an empty batch', async () => {
    expect(await writeLogBatch(db, [])).toEqual({ written: 0, duplicates: 0, invalid: 0, unknownProject: 0 })
  })
})

describe('writeLogBatch: tenant scoping', () => {
  it("never points one project's row at another project's tool or key", async () => {
    // An event for project A that names B's tool and B's key.
    const e = toolCall(a, { toolId: b.toolIds['listPets']!, apiKeyId: b.apiKeyId })
    await writeLogBatch(db, [e])

    const row = await db.toolCallLog.findUniqueOrThrow({ where: { id: e.id } })
    expect(row.projectId).toBe(a.projectId)
    expect(row.toolId).toBeNull()
    expect(row.apiKeyId).toBeNull()
    expect(row.toolName).toBe('listPets') // the name snapshot stays
  })

  it('keeps each project’s rows under its own project', async () => {
    const ea = toolCall(a)
    const eb = toolCall(b)
    await writeLogBatch(db, [ea, eb])

    const rowA = await db.toolCallLog.findUniqueOrThrow({ where: { id: ea.id } })
    const rowB = await db.toolCallLog.findUniqueOrThrow({ where: { id: eb.id } })
    expect(rowA.projectId).toBe(a.projectId)
    expect(rowB.projectId).toBe(b.projectId)
    expect(rowB.toolId).toBe(b.toolIds['listPets'])
  })

  it('a tool or key deleted since the call does not fail the batch', async () => {
    const doomed = await createFixture()
    const e = toolCall(doomed)
    await db.tool.delete({ where: { id: doomed.toolIds['listPets']! } })
    await db.apiKey.delete({ where: { id: doomed.apiKeyId } })

    expect((await writeLogBatch(db, [e])).written).toBe(1)
    expect(await db.toolCallLog.findUniqueOrThrow({ where: { id: e.id } })).toMatchObject({ toolId: null, apiKeyId: null, toolName: 'listPets' })
  })

  it('an event for a project deleted since the call is dropped, not an error', async () => {
    const gone = await createFixture()
    const e = toolCall(gone)
    await db.project.delete({ where: { id: gone.projectId } })

    const result = await writeLogBatch(db, [e, toolCall(a)])
    expect(result).toMatchObject({ written: 1, unknownProject: 1 })
  })
})

describe('log rows follow their project', () => {
  it('are deleted with the project, and the tool/key foreign keys are indexed', async () => {
    const fx = await createFixture()
    const e = toolCall(fx)
    await writeLogBatch(db, [e])
    await db.project.delete({ where: { id: fx.projectId } })
    expect(await rowsOf([e.id])).toHaveLength(0)

    const indexes = await db.$queryRaw<Array<{ indexname: string }>>`SELECT indexname FROM pg_indexes WHERE tablename = 'tool_call_logs'`
    const names = indexes.map((i) => i.indexname)
    expect(names).toEqual(
      expect.arrayContaining([
        'tool_call_logs_project_id_created_at_idx',
        'tool_call_logs_project_id_tool_name_created_at_idx',
        'tool_call_logs_created_at_idx',
        'tool_call_logs_tool_id_idx',
        'tool_call_logs_api_key_id_idx',
      ])
    )
  })
})
