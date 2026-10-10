/**
 * Integration test harness: real Postgres (test database) and Redis (database 1), a real
 * gateway on an ephemeral port, a local mock upstream, and MCP clients of both SDK
 * generations. Loopback upstreams are allowed the way the spec allows them (NODE_ENV=development
 * plus ALLOW_PRIVATE_UPSTREAMS=true), which each test file turns on and off itself.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { encrypt, generateApiKey } from '@mcp-gateway/crypto'
import { db } from '@mcp-gateway/db'
import { extractTools } from '@mcp-gateway/openapi-tools'
import { Client as ClientV2, StreamableHTTPClientTransport as TransportV2 } from '@modelcontextprotocol/client'
import { Client as ClientV1 } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport as TransportV1 } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { LogEvent } from '@mcp-gateway/shared'
import { Redis } from 'ioredis'
import { buildApp } from '../app.js'
import type { LogSink } from '../logging/index.js'
import type { AppConfig } from '../config.js'

export const ENCRYPTION_KEY = 'ab'.repeat(32)

export const TEST_CONFIG: AppConfig = {
  encryptionKey: ENCRYPTION_KEY,
  toolTimeoutMs: 5_000,
  toolMaxResponseBytes: 64 * 1024,
  configCacheTtlSeconds: 300,
  apiKeyCacheTtlSeconds: 30,
  lastUsedIntervalMs: 60_000,
  rateLimitWindowMs: 60_000,
  rateLimitBreakerMs: 5_000,
}

// ---------------------------------------------------------------------------
// The fixture API: a small pet shop described the way a real spec would be.
// ---------------------------------------------------------------------------

const str = { type: 'string' }
const ok = { '200': { description: 'ok' } }

export const SPEC = {
  openapi: '3.0.3',
  info: { title: 'Petshop', version: '1.0.0' },
  paths: {
    '/pets': {
      get: {
        operationId: 'listPets',
        summary: 'List pets',
        parameters: [
          { name: 'limit', in: 'query', schema: { type: 'integer' } },
          { name: 'tag', in: 'query', schema: { type: 'array', items: str } },
        ],
        responses: ok,
      },
      post: {
        operationId: 'createPet',
        summary: 'Create a pet',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { type: 'object', required: ['name'], properties: { name: str, tag: str } },
            },
          },
        },
        responses: ok,
      },
    },
    '/pets/{petId}': {
      parameters: [{ name: 'petId', in: 'path', required: true, schema: { type: 'integer' } }],
      get: {
        operationId: 'getPet',
        summary: 'Get a pet',
        parameters: [
          { name: 'verbose', in: 'query', schema: { type: 'boolean' } },
          { name: 'X-Trace', in: 'header', schema: str },
        ],
        responses: ok,
      },
      put: {
        operationId: 'updatePet',
        summary: 'Update a pet',
        requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { id: str, name: str } } } } },
        responses: ok,
      },
      delete: { operationId: 'deletePet', summary: 'Delete a pet', responses: ok },
    },
    '/things/{id}': {
      put: {
        operationId: 'updateThing',
        summary: 'Update a thing (path id and body id clash)',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }],
        requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { id: str, name: str } } } } },
        responses: ok,
      },
    },
    '/tenant/items': {
      get: {
        operationId: 'listTenantItems',
        summary: 'List items of a tenant',
        parameters: [
          { name: 'tenant', in: 'query', required: true, schema: str },
          { name: 'q', in: 'query', schema: str },
        ],
        responses: ok,
      },
    },
    '/slow': { get: { operationId: 'slow', summary: 'Never answers in time', responses: ok } },
    '/big': { get: { operationId: 'big', summary: 'A huge response', responses: ok } },
    '/image': { get: { operationId: 'image', summary: 'A binary response', responses: ok } },
    '/empty': { delete: { operationId: 'emptyThing', summary: 'No content', responses: ok } },
    '/moved': { get: { operationId: 'moved', summary: 'Redirects', responses: ok } },
  },
}

// ---------------------------------------------------------------------------
// Database fixtures
// ---------------------------------------------------------------------------

export interface CredentialSpec {
  type: 'BEARER' | 'CUSTOM_HEADER' | 'QUERY_PARAM'
  value: string
  headerName?: string
  queryParamName?: string
}

export interface FixtureOptions {
  upstreamBaseUrl?: string
  credential?: CredentialSpec
  /** operationId → hidden params ({ name: { value } }). */
  hidden?: Record<string, Record<string, { value: unknown }>>
  disabled?: string[]
  removed?: string[]
}

export interface Fixture {
  userId: string
  projectId: string
  slug: string
  apiKey: string
  apiKeyId: string
  apiKeyHash: string
  toolIds: Record<string, string>
}

const createdUsers: string[] = []
let counter = 0
const unique = () => `${Date.now().toString(36)}${(counter++).toString(36)}${Math.random().toString(36).slice(2, 6)}`

export async function createFixture(options: FixtureOptions = {}): Promise<Fixture> {
  const tag = unique()
  const user = await db.user.create({ data: { email: `gw-${tag}@test.local`, name: 'Gateway test' } })
  createdUsers.push(user.id)

  const slug = `gw-${tag}`
  const project = await db.project.create({
    data: {
      userId: user.id,
      name: 'Petshop',
      slug,
      upstreamBaseUrl: options.upstreamBaseUrl ?? '',
      openapiSpec: SPEC,
      specVersion: '1.0.0',
    },
  })

  // Tool rows come from the real extractor, exactly as an import would create them.
  const toolIds: Record<string, string> = {}
  for (const def of extractTools(SPEC)) {
    const row = await db.tool.create({
      data: {
        projectId: project.id,
        operationId: def.operationId,
        method: def.method,
        path: def.path,
        name: def.name,
        description: def.description,
        specName: def.name,
        specDescription: def.description,
        inputSchema: def.inputSchema as object,
        enabled: !options.disabled?.includes(def.operationId),
        removedAt: options.removed?.includes(def.operationId) ? new Date() : null,
        hiddenParams: (options.hidden?.[def.operationId] ?? {}) as object,
      },
    })
    toolIds[def.operationId] = row.id
  }

  if (options.credential) {
    const c = options.credential
    await db.upstreamCredential.create({
      data: {
        projectId: project.id,
        type: c.type,
        encryptedValue: encrypt(c.value, ENCRYPTION_KEY),
        headerName: c.headerName ?? null,
        queryParamName: c.queryParamName ?? null,
      },
    })
  }

  const key = generateApiKey()
  const apiKey = await db.apiKey.create({
    data: { projectId: project.id, name: 'test key', prefix: key.prefix, hash: key.hash },
  })

  return { userId: user.id, projectId: project.id, slug, apiKey: key.key, apiKeyId: apiKey.id, apiKeyHash: key.hash, toolIds }
}

/** A second API key for a fixture's project. */
export async function addApiKey(projectId: string, revoked = false, rateLimitPerMin?: number) {
  const key = generateApiKey()
  const row = await db.apiKey.create({
    data: {
      projectId,
      name: 'extra',
      prefix: key.prefix,
      hash: key.hash,
      revokedAt: revoked ? new Date() : null,
      ...(rateLimitPerMin !== undefined ? { rateLimitPerMin } : {}),
    },
  })
  return { key: key.key, id: row.id, hash: key.hash }
}

export async function cleanupFixtures(): Promise<void> {
  await db.user.deleteMany({ where: { id: { in: createdUsers.splice(0) } } })
}

// ---------------------------------------------------------------------------
// The gateway under test
// ---------------------------------------------------------------------------

/** Keeps events in memory so a test can look at what the gateway logged. */
export class CollectingSink implements LogSink {
  readonly events: LogEvent[] = []
  closed = false
  enqueue(event: LogEvent): void {
    this.events.push(event)
  }
  async close(): Promise<void> {
    this.closed = true
  }
}

export interface RunningGateway {
  /** The sink the gateway logs to (an in-memory CollectingSink unless the test supplied its own). */
  logSink: LogSink
  baseUrl: string
  redis: Redis
  mcpUrl(slug: string): string
  close(): Promise<void>
}

// GATEWAY_TEST_LOG=1 prints the gateway's warnings during a test run (Redis failures, fail-open limiting).
const testLogger = () => (process.env['GATEWAY_TEST_LOG'] ? { level: 'warn' } : false)

export async function startGateway(options: { config?: Partial<AppConfig>; redisUrl?: string; logSink?: LogSink } = {}): Promise<RunningGateway> {
  const redis = new Redis(options.redisUrl ?? process.env['REDIS_URL_TEST'] ?? 'redis://localhost:6379/1', {
    maxRetriesPerRequest: 1,
    connectTimeout: 1_000,
    // No commandTimeout here (the real gateway has 1 s). Nothing in the suite tests a hung Redis, a dead one
    // fails at once without it, and under a loaded machine a 500 ms limit made healthy Redis calls fail,
    // which made the cache miss and the limiter fail open (as designed) in tests that assert exact behaviour.
    enableOfflineQueue: false,
    lazyConnect: true,
  })
  redis.on('error', () => undefined)
  await redis.connect().catch(() => undefined)

  const logSink = options.logSink ?? new CollectingSink()
  const app = await buildApp({ db, redis, config: { ...TEST_CONFIG, ...options.config }, logSink, logger: testLogger() })
  await app.listen({ port: 0, host: '127.0.0.1' })
  const baseUrl = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`

  return {
    logSink,
    baseUrl,
    redis,
    mcpUrl: (slug) => `${baseUrl}/mcp/${slug}`,
    close: async () => {
      await app.close()
      redis.disconnect()
    },
  }
}

// ---------------------------------------------------------------------------
// A mock upstream API
// ---------------------------------------------------------------------------

export interface RecordedRequest {
  method: string
  url: string
  headers: IncomingMessage['headers']
  body: string
}

export interface MockUpstream {
  url: string
  requests: RecordedRequest[]
  close(): Promise<void>
}

export async function startUpstream(
  handler: (req: IncomingMessage, res: ServerResponse, recorded: RecordedRequest) => void,
  options: {
    /**
     * Take this long to record and answer each request, like a slow or loaded server. A request that
     * outlives the test that made it is then recorded late, inside a later test's counting window,
     * which is how such leaks show up. Requests the gateway has answered are still recorded first.
     */
    acceptDelayMs?: number
  } = {}
): Promise<MockUpstream> {
  const requests: RecordedRequest[] = []
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      const recorded = { method: req.method!, url: req.url!, headers: req.headers, body: Buffer.concat(chunks).toString() }
      const accept = () => {
        requests.push(recorded)
        handler(req, res, recorded)
      }
      if (options.acceptDelayMs) setTimeout(accept, options.acceptDelayMs)
      else accept()
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))

  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    requests,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      }),
  }
}

export const json = (res: ServerResponse, body: unknown, status = 200) => {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

// ---------------------------------------------------------------------------
// Talking to the gateway
// ---------------------------------------------------------------------------

export interface RpcResponse {
  status: number
  headers: { get(name: string): string | null }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  body: Record<string, any>
}

/** One raw JSON-RPC call over HTTP, without any SDK in between. */
export async function rpc(
  url: string,
  key: string | undefined,
  method: string,
  params?: object,
  headers: Record<string, string> = {}
): Promise<RpcResponse> {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...(key ? { authorization: `Bearer ${key}` } : {}),
      ...headers,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  })
  const text = await res.text()
  const dataLine = text.split('\n').find((l) => l.startsWith('data: '))
  let body: unknown
  try {
    body = JSON.parse(dataLine ? dataLine.slice(6) : text)
  } catch {
    body = text
  }
  return { status: res.status, headers: res.headers, body: body as RpcResponse['body'] }
}

export async function connectV2(url: string, key: string, mode: 'legacy' | 'auto' | { pin: string } = 'legacy') {
  const client = new ClientV2({ name: 'test-v2', version: '0.0.1' }, { versionNegotiation: { mode } })
  await client.connect(new TransportV2(new URL(url), { requestInit: { headers: { authorization: `Bearer ${key}` } } }))
  return client
}

export async function connectV1(url: string, key: string) {
  const client = new ClientV1({ name: 'test-v1', version: '0.0.1' })
  await client.connect(new TransportV1(new URL(url), { requestInit: { headers: { authorization: `Bearer ${key}` } } }))
  return client
}

/** Text of the first content block of a tool result. */
export function textOf(result: unknown): string {
  const first = (result as { content?: Array<{ type: string; text?: string }> }).content?.[0]
  return first?.type === 'text' ? (first.text ?? '') : ''
}
