import type { Logger } from '../config.js'
import { createQueueWriter } from './queue.js'
import { BufferedLogSink, type LogSink } from './sink.js'

export { CallLogger } from './call-logger.js'
export { BufferedLogSink } from './sink.js'
export type { LogSink, LogWriter } from './sink.js'

export interface LogSettings {
  /** `queue`: batches go to BullMQ for the worker. */
  sink: 'queue'
  redisUrl: string
  bufferMax: number
  batchSize: number
  flushIntervalMs: number
  shutdownFlushMs: number
}

/** Build the sink the settings ask for. */
export async function createLogSink(settings: LogSettings, log: Logger): Promise<LogSink> {
  const queue = await createQueueWriter(settings.redisUrl, log)
  return new BufferedLogSink({
    writer: queue.writer,
    dispose: queue.dispose,
    log,
    maxBuffer: settings.bufferMax,
    batchSize: settings.batchSize,
    flushIntervalMs: settings.flushIntervalMs,
    shutdownFlushMs: settings.shutdownFlushMs,
  })
}
