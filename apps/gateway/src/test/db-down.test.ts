import net from 'node:net'
import type { AddressInfo } from 'node:net'
import { generateApiKey } from '@mcp-gateway/crypto'
import { createPrismaClient, type PrismaClient } from '@mcp-gateway/db'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { cleanupFixtures, createFixture, rpc, startGateway, type Fixture, type RunningGateway } from './harness.js'

// Postgres is a listener that accepts connections and never answers (what a stopped container can look like behind
// Docker Desktop's port proxy), with a short connect timeout. Redis is the real one, so a call that is cached keeps
// working and one that is not must fail with a clean error, quickly.

const FAIL_WITHIN_MS = 3_000

let healthy: RunningGateway
let down: RunningGateway
let silent: net.Server
const sockets: net.Socket[] = []
let deadDb: PrismaClient
let fx: Fixture

beforeAll(async () => {
  silent = net.createServer((socket) => {
    sockets.push(socket)
    socket.on('error', () => undefined)
  })
  await new Promise<void>((resolve) => silent.listen(0, '127.0.0.1', resolve))
  const port = (silent.address() as AddressInfo).port
  deadDb = createPrismaClient({ DATABASE_URL: `postgresql://postgres:postgres@127.0.0.1:${port}/mcpgateway`, DATABASE_CONNECT_TIMEOUT_MS: '300', DATABASE_POOL_MAX: '2' })

  // Warm the shared Redis cache through a gateway whose database works.
  healthy = await startGateway()
  fx = await createFixture()
  await rpc(healthy.mcpUrl(fx.slug), fx.apiKey, 'tools/list')

  down = await startGateway({ db: deadDb })
}, 60_000)

afterAll(async () => {
  await down?.close()
  await healthy?.close()
  for (const socket of sockets) socket.destroy()
  await new Promise<void>((resolve) => silent.close(() => resolve()))
  await deadDb?.$disconnect().catch(() => undefined)
  await cleanupFixtures()
})

describe('Postgres is down', () => {
  it('a call whose key and project are cached still works', async () => {
    const res = await rpc(down.mcpUrl(fx.slug), fx.apiKey, 'tools/list')
    expect(res.status).toBe(200)
    expect((res.body['result']['tools'] as Array<{ name: string }>).map((t) => t.name)).toContain('getPet')
  })

  it('a cache miss answers 503 with a clean message, within the connect timeout', async () => {
    const started = performance.now()
    const res = await rpc(down.mcpUrl(fx.slug), generateApiKey().key, 'tools/list')
    expect(performance.now() - started).toBeLessThan(FAIL_WITHIN_MS)
    expect(res.status).toBe(503)
    expect(res.body).toEqual({ jsonrpc: '2.0', error: { code: -32603, message: 'The gateway is temporarily unavailable' }, id: null })
  })

  it('/health reports postgres as an error within the connect timeout', async () => {
    const started = performance.now()
    const res = await fetch(`${down.baseUrl}/health`)
    expect(performance.now() - started).toBeLessThan(FAIL_WITHIN_MS)
    expect(res.status).toBe(503)
    expect(await res.json()).toMatchObject({ postgres: 'error', redis: 'ok' })
  })
})
