import { purgeOldLogs, type PrismaClient } from '@mcp-gateway/db'
import { Queue, Worker } from 'bullmq'
import type { Redis } from 'ioredis'

export const MAINTENANCE_QUEUE_NAME = 'log-maintenance'
export const RETENTION_SCHEDULER_ID = 'log-retention'
export const DEFAULT_RETENTION_EVERY_MS = 6 * 60 * 60 * 1000

/**
 * Queue mode: the worker deletes call logs older than `days`, on a BullMQ job scheduler.
 * `upsertJobScheduler` is idempotent, so restarting the worker (or running two) keeps one schedule,
 * and only one worker takes each run. The delete itself is `purgeOldLogs`, the same function the
 * gateway uses in direct mode.
 */
export async function startRetention(
  db: PrismaClient,
  connection: Redis,
  options: { days: number; everyMs?: number; queueName?: string }
): Promise<{ close(): Promise<void> }> {
  const name = options.queueName ?? MAINTENANCE_QUEUE_NAME
  const queue = new Queue(name, { connection })
  await queue.upsertJobScheduler(RETENTION_SCHEDULER_ID, { every: options.everyMs ?? DEFAULT_RETENTION_EVERY_MS }, { name: 'purge', data: {} })

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
