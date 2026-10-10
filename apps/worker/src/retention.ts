import { purgeOldLogs, type PrismaClient } from '@mcp-gateway/db'
import { Queue, Worker } from 'bullmq'
import type { Redis } from 'ioredis'

export const MAINTENANCE_QUEUE_NAME = 'log-maintenance'
export const RETENTION_SCHEDULER_ID = 'log-retention'
export const DEFAULT_RETENTION_EVERY_MS = 6 * 60 * 60 * 1000
export const DEFAULT_FIRST_RUN_DELAY_MS = 60_000

/**
 * Queue mode: the worker deletes call logs older than `days`, on a BullMQ job scheduler: the first
 * run about a minute after the worker boots (with jitter, so instances do not all run together,
 * the same as the gateway in direct mode), then every `everyMs`.
 *
 * Without `startDate`, BullMQ queues the first run immediately on every `upsertJobScheduler`, so a
 * worker that crash-loops would run the delete on every start. The upsert is idempotent, so
 * restarting the worker (or running two) keeps one schedule, and only one worker takes each run.
 * The delete itself is `purgeOldLogs`, the same function the gateway uses in direct mode.
 */
export async function startRetention(
  db: PrismaClient,
  connection: Redis,
  options: { days: number; everyMs?: number; firstRunDelayMs?: number; queueName?: string }
): Promise<{ close(): Promise<void> }> {
  const name = options.queueName ?? MAINTENANCE_QUEUE_NAME
  const queue = new Queue(name, { connection })
  const firstRunDelayMs = options.firstRunDelayMs ?? DEFAULT_FIRST_RUN_DELAY_MS
  await queue.upsertJobScheduler(
    RETENTION_SCHEDULER_ID,
    { every: options.everyMs ?? DEFAULT_RETENTION_EVERY_MS, startDate: new Date(Date.now() + Math.round(firstRunDelayMs * (1 + Math.random() * 0.5))) },
    { name: 'purge', data: {} }
  )

  const worker = new Worker(
    name,
    async () => {
      const deleted = await purgeOldLogs(db, { days: options.days })
      if (deleted > 0) console.log(`[worker] deleted ${deleted} call logs older than ${options.days} days`)
      return deleted
    },
    { connection }
  )
  worker.on('failed', (job, err) => console.error(`[worker] log retention run ${job?.id} failed:`, err.message))
  worker.on('error', (err) => console.error('[worker] retention worker error:', err.message))

  return {
    async close() {
      await worker.close()
      await queue.close()
    },
  }
}
