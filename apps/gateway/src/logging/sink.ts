import type { LogEvent } from '@mcp-gateway/shared'
import type { Logger } from '../config.js'

/** Where call events go. `enqueue` is synchronous and never throws, so logging cannot slow or fail a tool call. */
export interface LogSink {
  enqueue(event: LogEvent): void
  /** Flush what is buffered (bounded by a deadline) and release resources. Used on shutdown. */
  close(): Promise<void>
}

/** Persists a batch somewhere (BullMQ, or Postgres directly). May reject; the sink retries. */
export type LogWriter = (events: LogEvent[]) => Promise<void>

export interface BufferedSinkOptions {
  writer: LogWriter
  log: Logger
  /** Most events held in memory. When full, new events are dropped and counted. */
  maxBuffer: number
  /** Events per write. */
  batchSize: number
  flushIntervalMs: number
  /** How long `close` keeps trying to empty the buffer. */
  shutdownFlushMs: number
  /**
   * A write that takes longer than this counts as failed and is retried. Needed because BullMQ's
   * `add` does not reject while Redis is down: it waits for the connection. A write that was only
   * slow may still land later; that is harmless, because events carry their ids and the
   * database ignores a repeat.
   */
  writeTimeoutMs?: number
  /** Called once after the final flush (close a queue connection, for instance). */
  dispose?: () => Promise<void>
  now?: () => number
}

export interface SinkStats {
  buffered: number
  written: number
  /** Events lost to a full buffer, a closed sink or a failed final flush. */
  dropped: number
  consecutiveFailures: number
}

const MAX_BACKOFF_MS = 30_000
const DEFAULT_WRITE_TIMEOUT_MS = 10_000
const DROP_WARNING_EVERY_MS = 30_000

/**
 * An in-memory buffer drained in batches by a background timer. Both sink modes use it and
 * differ only in the writer.
 *
 * - Bounded: at `maxBuffer` events a new event is dropped (and counted) rather than queued. The
 *   oldest events are kept, which describe the start of an incident; dropping is O(1).
 * - A failed write puts the batch back at the front, and retries with exponential backoff.
 *   Events wait in the buffer meanwhile and are still subject to the cap.
 * - One write at a time, so batches reach the writer in order.
 */
export class BufferedLogSink implements LogSink {
  private buffer: LogEvent[] = []
  private readonly timer: NodeJS.Timeout
  private inFlight: Promise<void> | null = null
  private closed = false
  private failures = 0
  private retryAt = 0
  private written = 0
  private dropped = 0
  private droppedSinceWarning = 0
  private lastDropWarning = Number.NEGATIVE_INFINITY
  private readonly now: () => number

  constructor(private readonly options: BufferedSinkOptions) {
    this.now = options.now ?? Date.now
    // unref: the timer alone must not keep the process alive.
    this.timer = setInterval(() => void this.flush(), options.flushIntervalMs)
    this.timer.unref()
  }

  enqueue(event: LogEvent): void {
    if (this.closed || this.buffer.length >= this.options.maxBuffer) {
      this.drop(1)
      return
    }
    this.buffer.push(event)
    if (this.buffer.length >= this.options.batchSize) void this.flush()
  }

  stats(): SinkStats {
    return { buffered: this.buffer.length, written: this.written, dropped: this.dropped, consecutiveFailures: this.failures }
  }

  /** Write buffered events now (unless backing off after a failure and not `force`d). Never rejects. */
  flush(force = false): Promise<void> {
    this.inFlight ??= this.drain(force).finally(() => {
      this.inFlight = null
    })
    return this.inFlight
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    clearInterval(this.timer)

    const deadline = this.now() + this.options.shutdownFlushMs
    while (this.buffer.length > 0 && this.now() < deadline) {
      const remaining = deadline - this.now()
      await Promise.race([this.flush(true), new Promise<void>((resolve) => setTimeout(resolve, remaining).unref())])
      if (this.buffer.length > 0 && this.now() < deadline) await new Promise<void>((resolve) => setTimeout(resolve, 100).unref())
    }

    const lost = this.buffer.length
    if (lost > 0) {
      this.buffer = []
      this.dropped += lost
      this.options.log.warn({ lost }, 'log buffer could not be flushed before shutdown: events lost')
    }
    try {
      await this.options.dispose?.()
    } catch (err) {
      this.options.log.warn({ err: err instanceof Error ? err.message : String(err) }, 'log sink cleanup failed')
    }
  }

  private async drain(force: boolean): Promise<void> {
    while (this.buffer.length > 0) {
      if (!force && this.now() < this.retryAt) return
      const batch = this.buffer.splice(0, this.options.batchSize)
      try {
        await withTimeout(this.options.writer(batch), this.options.writeTimeoutMs ?? DEFAULT_WRITE_TIMEOUT_MS)
        this.written += batch.length
        this.failures = 0
        this.retryAt = 0
      } catch (err) {
        // Back at the front, so order is kept; anything that no longer fits is the newest and is dropped.
        this.buffer.unshift(...batch)
        const excess = this.buffer.length - this.options.maxBuffer
        if (excess > 0) {
          this.buffer.length = this.options.maxBuffer
          this.drop(excess)
        }
        this.failures++
        this.retryAt = this.now() + Math.min(MAX_BACKOFF_MS, 1_000 * 2 ** (this.failures - 1))
        this.options.log.warn(
          { err: err instanceof Error ? err.message : String(err), buffered: this.buffer.length, attempt: this.failures },
          'could not write call logs; will retry'
        )
        return
      }
    }
  }

  private drop(count: number): void {
    this.dropped += count
    this.droppedSinceWarning += count
    const now = this.now()
    if (now - this.lastDropWarning >= DROP_WARNING_EVERY_MS) {
      this.lastDropWarning = now
      this.options.log.warn({ dropped: this.droppedSinceWarning, buffered: this.buffer.length }, 'call log buffer is full: events dropped')
      this.droppedSinceWarning = 0
    }
  }
}

function withTimeout(promise: Promise<void>, ms: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`write did not finish within ${ms} ms`)), ms)
    timer.unref()
    promise.then(
      () => {
        clearTimeout(timer)
        resolve()
      },
      (err: unknown) => {
        clearTimeout(timer)
        reject(err)
      }
    )
  })
}
