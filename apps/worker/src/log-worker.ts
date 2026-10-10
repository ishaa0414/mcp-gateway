import { writeLogBatch, type PrismaClient, type WriteLogResult } from '@mcp-gateway/db'
import { LOG_QUEUE_NAME, logBatchSchema } from '@mcp-gateway/shared'
import { Worker } from 'bullmq'
import type { Redis } from 'ioredis'

/**
 * One queue job is one batch of call-log events, written with a single insert. A job that is
 * not a batch at all is dropped (retrying cannot fix it); a database failure throws, and
 * BullMQ retries the job with the backoff the gateway set. Retries are safe because every event
 * carries its own id, which becomes the row's primary key.
 */
export async function processLogJob(db: PrismaClient, data: unknown): Promise<WriteLogResult | null> {
  const batch = logBatchSchema.safeParse(data)
  if (!batch.success) {
    console.error('[worker] dropped a job that is not a batch of log events:', batch.error.message)
    return null
  }
  const result = await writeLogBatch(db, batch.data.events)
  if (result.invalid > 0 || result.unknownProject > 0) {
    console.warn(`[worker] skipped ${result.invalid} invalid and ${result.unknownProject} unattributable events`)
  }
  return result
}

export function startLogWorker(db: PrismaClient, connection: Redis, queueName: string = LOG_QUEUE_NAME): Worker {
  const worker = new Worker(queueName, (job) => processLogJob(db, job.data), { connection, concurrency: 2 })
  worker.on('failed', (job, err) => console.error(`[worker] job ${job?.id} failed (attempt ${job?.attemptsMade}):`, err.message))
  worker.on('error', (err) => console.error('[worker] worker error:', err.message))
  return worker
}
