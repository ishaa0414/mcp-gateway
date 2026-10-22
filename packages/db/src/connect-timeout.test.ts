import net from 'node:net'
import type { AddressInfo } from 'node:net'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { connectTimeoutMs, DEFAULT_CONNECT_TIMEOUT_MS } from './index.js'

// A dead database must fail fast. These tests need no Docker: they point the real client at a closed port and at a
// listener that accepts connections and never answers (what a stopped container can look like behind Docker
// Desktop's port proxy). Without a connect timeout the second kind never fails at all.

const CONNECT_TIMEOUT_MS = 300
// Generous against the timeout above: a loaded machine adds scheduling noise, a missing timeout adds minutes.
const FAIL_WITHIN_MS = 3_000
// A test that hangs is stopped by this, not by the suite.
const HANG_LIMIT_MS = 10_000

let silent: net.Server
let sockets: net.Socket[]
let silentUrl: string

beforeEach(async () => {
  sockets = []
  silent = net.createServer((socket) => {
    sockets.push(socket)
    socket.on('error', () => undefined)
  })
  await new Promise<void>((resolve) => silent.listen(0, '127.0.0.1', resolve))
  silentUrl = `postgresql://postgres:postgres@127.0.0.1:${(silent.address() as AddressInfo).port}/mcpgateway`
})

afterEach(async () => {
  for (const socket of sockets) socket.destroy()
  await new Promise<void>((resolve) => silent.close(() => resolve()))
  vi.unstubAllEnvs()
  globalThis.__prisma = undefined
})

/** A fresh client for `url`, built the way the apps build theirs: from the environment, on first use. */
async function freshDb(url: string, env: Record<string, string> = {}) {
  vi.resetModules()
  globalThis.__prisma = undefined
  vi.stubEnv('DATABASE_URL', url)
  vi.stubEnv('DATABASE_CONNECT_TIMEOUT_MS', String(CONNECT_TIMEOUT_MS))
  for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value)
  return (await import('./index.js')).db
}

/** Run `query`, and return how long it took to reject; fails the test if it resolves. */
async function timeToReject(query: () => Promise<unknown>): Promise<number> {
  const started = performance.now()
  await expect(query()).rejects.toThrow()
  return performance.now() - started
}

describe('a dead database fails fast', () => {
  it('a listener that accepts and never answers: the query rejects at the connect timeout', { timeout: HANG_LIMIT_MS }, async () => {
    const db = await freshDb(silentUrl)
    expect(await timeToReject(() => db.$queryRaw`SELECT 1`)).toBeLessThan(FAIL_WITHIN_MS)
  })

  it('a closed port: the query rejects at once', { timeout: HANG_LIMIT_MS }, async () => {
    // Port 1 is never listening. (A port that was free a moment ago could be taken by the time the test runs.)
    const db = await freshDb('postgresql://postgres:postgres@127.0.0.1:1/mcpgateway')
    expect(await timeToReject(() => db.$queryRaw`SELECT 1`)).toBeLessThan(FAIL_WITHIN_MS)
  })

  it('a small pool does not stay stuck: 5 queries at a silent listener all reject, and a sixth still can', { timeout: HANG_LIMIT_MS }, async () => {
    const db = await freshDb(silentUrl, { DATABASE_POOL_MAX: '2' })
    const started = performance.now()
    const results = await Promise.allSettled(Array.from({ length: 5 }, () => db.$queryRaw`SELECT 1`))
    expect(results.map((r) => r.status)).toEqual(Array(5).fill('rejected'))
    expect(performance.now() - started).toBeLessThan(FAIL_WITHIN_MS)

    // Every connection attempt of the first batch has ended, so the pool has room to try again.
    expect(await timeToReject(() => db.$queryRaw`SELECT 1`)).toBeLessThan(FAIL_WITHIN_MS)
  })
})

describe('DATABASE_CONNECT_TIMEOUT_MS', () => {
  it('is read as milliseconds', () => {
    expect(connectTimeoutMs({ DATABASE_CONNECT_TIMEOUT_MS: '10000' })).toBe(10_000)
  })

  it('falls back to 5 s when unset, empty, zero, negative, fractional or not a number', () => {
    expect(DEFAULT_CONNECT_TIMEOUT_MS).toBe(5_000)
    for (const value of [undefined, '', '0', '-1', '1.5', 'soon']) {
      expect(connectTimeoutMs({ DATABASE_CONNECT_TIMEOUT_MS: value })).toBe(5_000)
    }
  })
})
