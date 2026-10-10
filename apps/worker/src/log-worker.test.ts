import { randomUUID } from 'node:crypto'
import { db, type PrismaClient } from '@mcp-gateway/db'
import type { LogEvent } from '@mcp-gateway/shared'
import { Queue, type Worker } from 'bullmq'
import { Redis } from 'ioredis'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { processLogJob, startLogWorker } from './log-worker.js'

const REDIS_URL = process.env['REDIS_URL_TEST'] ?? 'redis://localhost:6379/1'

let userId: string
let projectA: { id: string; slug: string }
let projectB: { id: string; slug: string }
let connection: Redis
const opened: Array<{ worker: Worker; queue: Queue }> = []

async function makeProject(user: string) {
  const slug = `wk-${randomUUID().slice(0, 12)}`
  const p = await db.project.create({ data: { userId: user, name: 'Worker test', slug, upstreamBaseUrl: '' } })
  return { id: p.id, slug }
}

beforeAll(async () => {
  userId = (await db.user.create({ data: { email: `worker-${randomUUID()}@test.local` } })).id
  projectA = await makeProject(userId)
  projectB = await makeProject(userId)
  connection = new Redis(REDIS_URL, { maxRetriesPerRequest: null })
})

afterEach(async () => {
  for (const { worker, queue } of opened.splice(0)) {
    await worker.close()
    await queue.obliterate({ force: true }).catch(() => undefined)
    await queue.close()
  }
})

afterAll(async () => {
  await db.user.delete({ where: { id: userId } }) // cascades to projects and their logs
  connection.disconnect()
  await db.$disconnect()
})

const event = (projectId: string, patch: Partial<LogEvent> = {}): LogEvent => ({
  id: randomUUID(),
  kind: 'TOOL_CALL',
  projectId,
  apiKeyId: null,
  toolId: null,
  toolName: 'listPets',
  input: { limit: 1 },
  upstreamStatus: 200,
  latencyMs: 12,
  success: true,
  errorClass: null,
  errorMessage: null,
  responseBytes: 40,
  timestamp: Date.now(),
  ...patch,
})

/** A queue and a worker on a name of their own, so tests cannot take each other's jobs. */
function start(workerDb: PrismaClient = db) {
  const name = `test-worker-${randomUUID()}`
  const worker = startLogWorker(workerDb, connection, name)
  const queue = new Queue(name, { connection })
  opened.push({ worker, queue })
  return queue
}

const rows = (ids: string[]) => db.toolCallLog.findMany({ where: { id: { in: ids } } })
const settled = async (ids: string[], count: number) =>
  vi.waitFor(async () => expect(await rows(ids)).toHaveLength(count), { timeout: 8_000, interval: 100 })

describe('log worker', () => {
  it('writes a job batch to Postgres, one row per event', async () => {
    const queue = start()
    const events = [event(projectA.id), event(projectA.id, { success: false, errorClass: 'UPSTREAM_5XX', upstreamStatus: 500 }), event(projectB.id)]
    await queue.add('batch', { events })

    await settled(events.map((e) => e.id), 3)
    const byId = new Map((await rows(events.map((e) => e.id))).map((r) => [r.id, r]))
    expect(byId.get(events[0]!.id)).toMatchObject({ projectId: projectA.id, success: true })
    expect(byId.get(events[1]!.id)).toMatchObject({ projectId: projectA.id, errorClass: 'UPSTREAM_5XX', upstreamStatus: 500 })
    expect(byId.get(events[2]!.id)).toMatchObject({ projectId: projectB.id }) // each tenant's own project
  })

  it('stores a batch once even if it is delivered twice (BullMQ retry, or a slow write that landed late)', async () => {
    const queue = start()
    const events = [event(projectA.id), event(projectA.id)]
    const extra = event(projectA.id)
    await queue.add('batch', { events })
    await queue.add('batch', { events })
    await queue.add('batch', { events: [...events, extra] })

    await settled([...events, extra].map((e) => e.id), 3)
    await new Promise((r) => setTimeout(r, 500)) // let the remaining jobs finish
    expect(await rows([...events, extra].map((e) => e.id))).toHaveLength(3)
  })

  it('drops a job that is not a batch and keeps working', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const queue = start()
    await queue.add('batch', { nothing: 'to see' })
    const good = event(projectA.id)
    await queue.add('batch', { events: [good] })

    await settled([good.id], 1)
    errors.mockRestore()
  })

  it('writes the valid events of a batch and skips the invalid ones', async () => {
    const warnings = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const queue = start()
    const good = event(projectA.id)
    await queue.add('batch', { events: [{ ...event(projectA.id), latencyMs: -1 }, 'garbage', good] })

    await settled([good.id], 1)
    warnings.mockRestore()
  })

  it('retries a job when the database fails, then writes it', async () => {
    let failures = 0
    const flaky = new Proxy(db, {
      get(target, prop, receiver) {
        if (prop === 'project') {
          return {
            findMany: (...args: Parameters<typeof db.project.findMany>) => {
              if (failures++ < 2) throw new Error('connection lost')
              return db.project.findMany(...args)
            },
          }
        }
        return Reflect.get(target, prop, receiver)
      },
    }) as PrismaClient
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    const queue = start(flaky)
    const e = event(projectA.id)
    await queue.add('batch', { events: [e] }, { attempts: 5, backoff: { type: 'fixed', delay: 100 } })

    await settled([e.id], 1)
    expect(failures).toBeGreaterThanOrEqual(3)
    errors.mockRestore()
  })
})

describe('processLogJob', () => {
  it('reports what it wrote', async () => {
    const e = event(projectA.id)
    expect(await processLogJob(db, { events: [e, e] })).toMatchObject({ written: 1 })
    expect(await processLogJob(db, { events: [e] })).toMatchObject({ written: 0, duplicates: 1 })
  })

  it('returns null for something that is not a batch', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    expect(await processLogJob(db, 'nope')).toBeNull()
    expect(await processLogJob(db, { events: 'nope' })).toBeNull()
    errors.mockRestore()
  })

  it('lets a database error through so the job is retried', async () => {
    const broken = { project: { findMany: () => Promise.reject(new Error('down')) } } as unknown as PrismaClient
    await expect(processLogJob(broken, { events: [event(projectA.id)] })).rejects.toThrow('down')
  })
})
