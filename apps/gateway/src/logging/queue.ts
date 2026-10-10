import type { LogEvent } from '@mcp-gateway/shared'
import { LOG_QUEUE_NAME } from '@mcp-gateway/shared'
import type { Logger } from '../config.js'
import type { LogWriter } from './sink.js'

export interface QueueWriter {
  writer: LogWriter
  /** Close the queue's own Redis connection. */
  dispose(): Promise<void>
}

/**
 * Queue mode: each batch becomes one BullMQ job that the worker writes with one `createMany`.
 * BullMQ is imported here, not at the top of the gateway, so `direct` mode never loads it.
 *
 * The queue has its own Redis connection that fails fast: with the offline queue off, a Redis
 * outage rejects `add` immediately (the sink keeps the batch and retries) instead of hanging.
 */
export async function createQueueWriter(redisUrl: string, log: Logger, queueName: string = LOG_QUEUE_NAME): Promise<QueueWriter> {
  const [{ Queue }, { Redis }] = await Promise.all([import('bullmq'), import('ioredis')])

  const connection = new Redis(redisUrl, { maxRetriesPerRequest: 1, enableOfflineQueue: false, connectTimeout: 2_000 })
  connection.on('error', () => undefined) // surfaced as failed writes, which the sink logs and retries
  const queue = new Queue<{ events: LogEvent[] }>(queueName, { connection })
  queue.on('error', (err) => log.warn({ err: err.message }, 'log queue error'))

  return {
    writer: async (events) => {
      await queue.add(
        'batch',
        { events },
        {
          attempts: 5,
          backoff: { type: 'exponential', delay: 2_000 },
          removeOnComplete: { count: 100 },
          removeOnFail: { age: 7 * 24 * 3600, count: 1_000 },
        }
      )
    },
    dispose: async () => {
      await queue.close()
      connection.disconnect()
    },
  }
}
