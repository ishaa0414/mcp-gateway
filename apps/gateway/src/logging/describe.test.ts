import { describe, expect, it } from 'vitest'
import { describeLogSettings, type LogSettings } from './index.js'

const base: LogSettings = {
  sink: 'direct',
  redisUrl: 'redis://localhost:6379',
  bufferMax: 1_000,
  batchSize: 100,
  flushIntervalMs: 2_000,
  shutdownFlushMs: 5_000,
  retentionDays: 30,
}

describe('describeLogSettings', () => {
  it('names direct mode with its batch, interval and buffer', () => {
    const line = describeLogSettings(base)
    expect(line).toMatch(/^call logging: direct \(batch 100, every 2000 ms, buffer 1000/)
    expect(line).toContain('no worker needed')
    expect(line).toContain('keeps 30 days')
  })

  it('names queue mode and says it needs the worker', () => {
    const line = describeLogSettings({ ...base, sink: 'queue' })
    expect(line).toMatch(/^call logging: queue \(batch 100, every 2000 ms, buffer 1000/)
    expect(line).toContain('needs the worker')
  })

  it('reflects the configured numbers', () => {
    expect(describeLogSettings({ ...base, batchSize: 7, flushIntervalMs: 250, bufferMax: 42 })).toContain('batch 7, every 250 ms, buffer 42')
  })

  it('never includes the Redis URL, which can carry a password', () => {
    expect(describeLogSettings({ ...base, sink: 'queue', redisUrl: 'rediss://default:s3cret@host:6379' })).not.toMatch(/s3cret|rediss?:\/\//)
  })
})
