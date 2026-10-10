import type { LogEvent } from '@mcp-gateway/shared'
import { describe, expect, it, vi } from 'vitest'
import { BufferedLogSink, type LogWriter } from './sink.js'

const event = (n: number): LogEvent => ({
  id: `evt-${n}`,
  kind: 'TOOL_CALL',
  projectId: 'p1',
  apiKeyId: 'k1',
  toolId: null,
  toolName: 'listPets',
  input: {},
  upstreamStatus: 200,
  latencyMs: 5,
  success: true,
  errorClass: null,
  errorMessage: null,
  responseBytes: 10,
  timestamp: 1_000 + n,
})
const events = (count: number, from = 0) => Array.from({ length: count }, (_, i) => event(from + i))
const log = () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() })

function makeSink(overrides: Partial<ConstructorParameters<typeof BufferedLogSink>[0]> = {}) {
  const written: LogEvent[][] = []
  const writer: LogWriter = async (batch) => {
    written.push(batch)
  }
  const logger = log()
  let now = 1_000_000
  const sink = new BufferedLogSink({
    writer,
    log: logger,
    maxBuffer: 1_000,
    batchSize: 100,
    flushIntervalMs: 3_600_000, // effectively never: tests flush by hand
    shutdownFlushMs: 500,
    now: () => now,
    ...overrides,
  })
  return { sink, written, logger, advance: (ms: number) => (now += ms) }
}

describe('BufferedLogSink: batching', () => {
  it('writes in batches of at most batchSize, in order', async () => {
    const { sink, written } = makeSink({ batchSize: 100, maxBuffer: 1_000 })
    for (const e of events(250)) sink.enqueue(e) // 100 and 200 trigger flushes by size
    await sink.flush()

    expect(written.flat().map((e) => e.id)).toEqual(events(250).map((e) => e.id))
    expect(written.every((b) => b.length <= 100)).toBe(true)
    expect(sink.stats()).toMatchObject({ buffered: 0, written: 250, dropped: 0 })
    await sink.close()
  })

  it('does not write until a batch is full or the timer fires', async () => {
    const { sink, written } = makeSink()
    for (const e of events(5)) sink.enqueue(e)
    await Promise.resolve()
    expect(written).toHaveLength(0)
    expect(sink.stats().buffered).toBe(5)
    await sink.close()
  })

  it('flushes on the timer', async () => {
    const { sink, written } = makeSink({ flushIntervalMs: 20 })
    sink.enqueue(event(1))
    await vi.waitFor(() => expect(written).toHaveLength(1), { timeout: 2_000 })
    expect(written[0]).toEqual([event(1)])
    await sink.close()
  })

  it('writes one batch at a time', async () => {
    let running = 0
    let maxRunning = 0
    const { sink } = makeSink({
      batchSize: 10,
      writer: async () => {
        running++
        maxRunning = Math.max(maxRunning, running)
        await new Promise((r) => setTimeout(r, 10))
        running--
      },
    })
    for (const e of events(60)) sink.enqueue(e)
    await sink.flush()
    expect(maxRunning).toBe(1)
    await sink.close()
  })
})

describe('BufferedLogSink: buffer cap', () => {
  it('drops new events when full, counts them, and warns once', async () => {
    let release!: () => void
    const blocked = new Promise<void>((resolve) => (release = resolve))
    const { sink, logger } = makeSink({ maxBuffer: 5, batchSize: 5, writer: () => blocked })

    for (const e of events(5)) sink.enqueue(e) // fills the buffer; the size trigger takes the 5 into a write
    for (const e of events(5, 5)) sink.enqueue(e) // refills while the first batch is in flight
    for (const e of events(20, 10)) sink.enqueue(e) // full: dropped

    expect(sink.stats()).toMatchObject({ buffered: 5, dropped: 20 })
    expect(logger.warn).toHaveBeenCalledTimes(1)
    expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({ dropped: 1 }), 'call log buffer is full: events dropped')
    release()
    await sink.close()
  })

  it('keeps the oldest events, not the newest', async () => {
    const written: LogEvent[][] = []
    const { sink } = makeSink({ maxBuffer: 3, batchSize: 3, writer: async (b) => void written.push(b) })
    // Fill without letting the size trigger drain (the writer is sync-fast, so hold the buffer with a failing first write).
    for (const e of events(10)) sink.enqueue(e)
    await sink.flush(true)
    expect(written.flat().map((e) => e.id)).toContain('evt-0')
    expect(written.flat().map((e) => e.id)).not.toContain('evt-9')
    await sink.close()
  })

  it('reports drops again after the warning interval', async () => {
    const { sink, logger, advance } = makeSink({ maxBuffer: 1, batchSize: 1, writer: () => new Promise(() => undefined) })
    sink.enqueue(event(0)) // goes into the stuck write
    sink.enqueue(event(1)) // buffered
    sink.enqueue(event(2)) // dropped, warns
    sink.enqueue(event(3)) // dropped, within 30 s: no new warning
    expect(logger.warn).toHaveBeenCalledTimes(1)

    advance(31_000)
    sink.enqueue(event(4))
    expect(logger.warn).toHaveBeenCalledTimes(2)
    expect(logger.warn).toHaveBeenLastCalledWith(expect.objectContaining({ dropped: 2 }), expect.any(String))
    void sink.close()
  })
})

describe('BufferedLogSink: write failures', () => {
  it('keeps the batch, in order, and retries it after the backoff', async () => {
    let fail = true
    const written: LogEvent[][] = []
    const { sink, advance, logger } = makeSink({
      batchSize: 10,
      writer: async (b) => {
        if (fail) throw new Error('db down')
        written.push(b)
      },
    })
    for (const e of events(10)) sink.enqueue(e)
    await sink.flush()
    expect(sink.stats()).toMatchObject({ buffered: 10, written: 0, consecutiveFailures: 1 })
    expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({ err: 'db down', attempt: 1 }), expect.any(String))

    // Inside the backoff window nothing is attempted.
    fail = false
    await sink.flush()
    expect(written).toHaveLength(0)

    advance(1_000)
    await sink.flush()
    expect(written.flat().map((e) => e.id)).toEqual(events(10).map((e) => e.id))
    expect(sink.stats()).toMatchObject({ buffered: 0, written: 10, consecutiveFailures: 0 })
    await sink.close()
  })

  it('backs off exponentially up to a limit', async () => {
    const writer = vi.fn(async () => {
      throw new Error('down')
    })
    const { sink, advance } = makeSink({ writer, batchSize: 1 })
    sink.enqueue(event(0))
    await sink.flush()
    const delays: number[] = []
    for (let i = 0; i < 7; i++) {
      let waited = 0
      const callsBefore = writer.mock.calls.length
      while (writer.mock.calls.length === callsBefore) {
        advance(500)
        waited += 500
        await sink.flush()
      }
      delays.push(waited)
    }
    expect(delays).toEqual([1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000])
    void sink.close()
  })

  it('drops the newest events when a failed batch plus new arrivals no longer fit', async () => {
    const { sink } = makeSink({
      maxBuffer: 10,
      batchSize: 10,
      writer: async () => {
        throw new Error('down')
      },
    })
    for (const e of events(10)) sink.enqueue(e)
    await sink.flush() // fails: 10 back in the buffer
    for (const e of events(4, 10)) sink.enqueue(e) // full: dropped
    expect(sink.stats()).toMatchObject({ buffered: 10, dropped: 4 })
    void sink.close()
  })

  it('enqueue never throws, whatever the writer does', () => {
    const { sink } = makeSink({
      batchSize: 1,
      writer: () => {
        throw new Error('sync explosion')
      },
    })
    expect(() => sink.enqueue(event(0))).not.toThrow()
    void sink.close()
  })
})

describe('BufferedLogSink: a write that never finishes', () => {
  it('counts as failed after the write timeout, keeps the batch and retries it', async () => {
    let calls = 0
    const written: LogEvent[][] = []
    const { sink, advance } = makeSink({
      batchSize: 5,
      writeTimeoutMs: 50,
      writer: (batch) => {
        if (++calls === 1) return new Promise<void>(() => undefined) // hangs, as BullMQ's add does without Redis
        written.push(batch)
        return Promise.resolve()
      },
    })
    for (const e of events(5)) sink.enqueue(e)
    await sink.flush()
    expect(sink.stats()).toMatchObject({ buffered: 5, consecutiveFailures: 1, written: 0 })

    advance(1_000)
    await sink.flush()
    expect(written.flat().map((e) => e.id)).toEqual(events(5).map((e) => e.id))
    expect(sink.stats()).toMatchObject({ buffered: 0, written: 5, consecutiveFailures: 0 })
    await sink.close()
  })
})

describe('BufferedLogSink: shutdown', () => {
  it('flushes everything that is buffered', async () => {
    const { sink, written } = makeSink({ batchSize: 100 })
    for (const e of events(30)) sink.enqueue(e)
    expect(written).toHaveLength(0)

    await sink.close()
    expect(written.flat()).toHaveLength(30)
    expect(sink.stats()).toMatchObject({ buffered: 0, written: 30, dropped: 0 })
  })

  it('keeps trying through a brief failure, within the deadline', async () => {
    let attempts = 0
    const written: LogEvent[][] = []
    const { sink } = makeSink({
      shutdownFlushMs: 2_000,
      now: Date.now,
      writer: async (b) => {
        if (++attempts < 3) throw new Error('blip')
        written.push(b)
      },
    })
    for (const e of events(5)) sink.enqueue(e)
    await sink.close()
    expect(written.flat()).toHaveLength(5)
  })

  it('gives up at the deadline, and says how many events were lost', async () => {
    const { sink, logger } = makeSink({
      shutdownFlushMs: 300,
      now: Date.now,
      writer: async () => {
        throw new Error('still down')
      },
    })
    for (const e of events(7)) sink.enqueue(e)

    const started = Date.now()
    await sink.close()

    expect(Date.now() - started).toBeLessThan(1_500)
    expect(logger.warn).toHaveBeenCalledWith({ lost: 7 }, expect.stringContaining('could not be flushed before shutdown'))
    expect(sink.stats()).toMatchObject({ buffered: 0, dropped: 7 })
  })

  it('does not wait forever on a writer that hangs', async () => {
    const { sink } = makeSink({ shutdownFlushMs: 300, now: Date.now, writer: () => new Promise(() => undefined) })
    sink.enqueue(event(0))
    const started = Date.now()
    await sink.close()
    expect(Date.now() - started).toBeLessThan(1_500)
  })

  it('drops events that arrive after close, and runs the cleanup once', async () => {
    const dispose = vi.fn(async () => undefined)
    const { sink } = makeSink({ dispose })
    await sink.close()
    await sink.close()
    sink.enqueue(event(1))
    expect(sink.stats()).toMatchObject({ buffered: 0, dropped: 1 })
    expect(dispose).toHaveBeenCalledTimes(1)
  })

  it('a failing cleanup does not make close throw', async () => {
    const { sink, logger } = makeSink({
      dispose: async () => {
        throw new Error('cannot close')
      },
    })
    await expect(sink.close()).resolves.toBeUndefined()
    expect(logger.warn).toHaveBeenCalledWith({ err: 'cannot close' }, 'log sink cleanup failed')
  })
})
