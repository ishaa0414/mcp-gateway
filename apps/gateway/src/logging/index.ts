import { writeLogBatch, type PrismaClient } from '@mcp-gateway/db'
import type { Logger } from '../config.js'
import { createQueueWriter } from './queue.js'
import { DEFAULT_RETENTION_TIMING, startRetention } from './retention.js'
import { BufferedLogSink } from './sink.js'

export { CallLogger } from './call-logger.js'
export { BufferedLogSink } from './sink.js'
export type { LogSink, LogWriter } from './sink.js'

export interface LogSettings {
  /**
   * `queue`: batches go to BullMQ and the worker writes them (and deletes old rows).
   * `direct`: the gateway writes batches to Postgres itself and deletes old rows itself; no worker, no BullMQ.
   */
  sink: 'queue' | 'direct'
  redisUrl: string
  bufferMax: number
  batchSize: number
  flushIntervalMs: number
  shutdownFlushMs: number
  /** Only used in `direct` mode (the worker handles it in `queue` mode). */
  retentionDays: number
  /** Overridable so tests need not wait. */
  retentionTiming?: { firstRunDelayMs: number; intervalMs: number }
}

/** One line for the startup log, so a wrong LOG_SINK is obvious from the first lines. */
export function describeLogSettings(s: LogSettings): string {
  const common = `batch ${s.batchSize}, every ${s.flushIntervalMs} ms, buffer ${s.bufferMax}`
  return s.sink === 'direct'
    ? `call logging: direct (${common}; the gateway writes to Postgres itself, keeps ${s.retentionDays} days, no worker needed)`
    : `call logging: queue (${common}; needs the worker to write the logs, they wait in Redis until it runs)`
}

/** Build the sink the settings ask for. */
export async function createLogSink(settings: LogSettings, { log, db }: { log: Logger; db: PrismaClient }): Promise<BufferedLogSink> {
  const common = {
    log,
    maxBuffer: settings.bufferMax,
    batchSize: settings.batchSize,
    flushIntervalMs: settings.flushIntervalMs,
    shutdownFlushMs: settings.shutdownFlushMs,
  }

  if (settings.sink === 'queue') {
    const queue = await createQueueWriter(settings.redisUrl, log)
    return new BufferedLogSink({ ...common, writer: queue.writer, dispose: queue.dispose })
  }

  // Direct mode: BullMQ is never loaded, and nothing polls Redis for logs.
  const retention = startRetention(db, log, { days: settings.retentionDays, ...(settings.retentionTiming ?? DEFAULT_RETENTION_TIMING) })
  return new BufferedLogSink({
    ...common,
    writer: async (events) => {
      const result = await writeLogBatch(db, events)
      if (result.invalid > 0 || result.unknownProject > 0) {
        log.warn({ invalid: result.invalid, unknownProject: result.unknownProject }, 'some call log events could not be stored')
      }
    },
    dispose: async () => retention.stop(),
  })
}
