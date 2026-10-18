/**
 * callUpstream: the one upstream call path. The MCP outcome must not change, and the preview the
 * dashboard playground gets must never hold the upstream credential or a hidden parameter's value.
 * No database or Redis: a local upstream and hand-built project configuration.
 */
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { encrypt } from '@mcp-gateway/crypto'
import { buildRequestMap, extractTools, toAgentSchema } from '@mcp-gateway/openapi-tools'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CachedTool, CredentialKind, ProjectConfig } from '../cache/project-config.js'
import type { AppConfig } from '../config.js'
import { callUpstream, DISPLAY_BODY_CHARS, executeTool, ValidatorCache } from './call-tool.js'

const KEY = 'ab'.repeat(32)
const BEARER = 'tok-bearer-4f9a7c21'
const QUERY_SECRET = 'qry secret/77+aa=90' // characters that get encoded in a URL
const HIDDEN_LONG = 'hidden-value-9f3a'
const REDACTED = '[REDACTED]'

const str = { type: 'string' }
const ok = { '200': { description: 'ok' } }
const SPEC = {
  openapi: '3.0.3',
  info: { title: 'Shop', version: '1' },
  paths: {
    '/pets/{petId}': {
      parameters: [{ name: 'petId', in: 'path', required: true, schema: { type: 'integer' } }],
      get: {
        operationId: 'getPet',
        parameters: [
          { name: 'verbose', in: 'query', schema: { type: 'boolean' } },
          { name: 'X-Trace', in: 'header', schema: str },
          { name: 'api_key', in: 'header', schema: str },
        ],
        responses: ok,
      },
    },
    '/pets': {
      post: {
        operationId: 'createPet',
        requestBody: {
          content: { 'application/json': { schema: { type: 'object', properties: { name: str, password: str, label: str } } } },
        },
        responses: ok,
      },
    },
    '/tenant/items': {
      get: {
        operationId: 'listItems',
        parameters: [
          { name: 'tenant', in: 'query', schema: str },
          { name: 'scope', in: 'query', schema: str },
        ],
        responses: ok,
      },
    },
    '/echo': { get: { operationId: 'echo', responses: ok } },
    '/headers': { get: { operationId: 'headers', responses: ok } },
    '/image': { get: { operationId: 'image', responses: ok } },
    '/big': { get: { operationId: 'big', responses: ok } },
  },
}

const CONFIG: AppConfig = {
  encryptionKey: KEY,
  toolTimeoutMs: 5_000,
  toolMaxResponseBytes: 1024 * 1024,
  configCacheTtlSeconds: 300,
  apiKeyCacheTtlSeconds: 30,
  lastUsedIntervalMs: 60_000,
  rateLimitWindowMs: 60_000,
  rateLimitBreakerMs: 5_000,
}
const deps = { config: CONFIG, log: { info() {}, warn() {}, error() {} }, validators: new ValidatorCache() }

let server: Server
let baseUrl: string
const received: { url: string; headers: IncomingHttpHeaders; body: string }[] = []

beforeAll(async () => {
  vi.stubEnv('NODE_ENV', 'development')
  vi.stubEnv('ALLOW_PRIVATE_UPSTREAMS', 'true')
  server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      received.push({ url: req.url!, headers: req.headers, body: Buffer.concat(chunks).toString() })
      const path = new URL(req.url!, 'http://x').pathname
      if (path === '/image') {
        res.writeHead(200, { 'content-type': 'image/png' })
        return res.end(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3]))
      }
      if (path === '/big') {
        res.writeHead(200, { 'content-type': 'text/plain' })
        return res.end('y'.repeat(150_000))
      }
      if (path === '/headers') {
        res.writeHead(200, {
          'content-type': 'application/json',
          'set-cookie': 'session=abc123; HttpOnly',
          'x-internal-host': 'db-7.internal',
          'ratelimit-remaining': '41',
          'x-ratelimit-limit': '50',
          'cache-control': 'no-store',
        })
        return res.end('{}')
      }
      if (path.startsWith('/pets/500')) {
        // A badly behaved upstream that echoes the request, credential included, inside its error.
        res.writeHead(500, { 'content-type': 'application/json' })
        return res.end(JSON.stringify({ error: 'boom', authorization: req.headers['authorization'], url: req.url, hidden: HIDDEN_LONG }))
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ path, query: new URL(req.url!, 'http://x').search, hidden: HIDDEN_LONG, auth: req.headers['authorization'] ?? null }))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve))
  vi.unstubAllEnvs()
})

beforeEach(() => {
  received.length = 0
})

function project(
  credential: { type: CredentialKind; value?: string; headerName?: string; queryParamName?: string } = { type: 'NONE' },
  upstreamBaseUrl = baseUrl
): ProjectConfig {
  return {
    projectId: 'p1',
    slug: 'shop',
    upstreamBaseUrl,
    credential: {
      type: credential.type,
      headerName: credential.headerName ?? null,
      queryParamName: credential.queryParamName ?? null,
      encryptedValue: credential.value === undefined ? null : encrypt(credential.value, KEY),
    },
    tools: [],
  }
}

function tool(operationId: string, hidden: Record<string, { value: unknown }> = {}): CachedTool {
  const def = extractTools(SPEC).find((t) => t.operationId === operationId)!
  return {
    // The validator cache is keyed by id and version, so a tool with other hidden parameters is another tool.
    id: `tool-${operationId}-${Object.keys(hidden).join(',')}`,
    name: def.name,
    description: def.description,
    method: def.method,
    path: def.path,
    agentSchema: toAgentSchema(def.inputSchema as object, hidden) as Record<string, unknown>,
    hidden: Object.fromEntries(Object.entries(hidden).map(([name, cfg]) => [name, cfg.value])),
    requestMap: buildRequestMap(SPEC, def.method, def.path)!,
    version: 1,
  }
}

describe('callUpstream: the MCP outcome', () => {
  it('is the same with and without a preview, and executeTool returns exactly that outcome', async () => {
    const p = project({ type: 'BEARER', value: BEARER })
    const t = tool('getPet')
    const plain = await callUpstream(p, t, { petId: 7, verbose: true }, deps)
    const previewed = await callUpstream(p, t, { petId: 7, verbose: true }, deps, { preview: true })
    expect(previewed.outcome).toEqual(plain.outcome)
    expect(await executeTool(p, t, { petId: 7, verbose: true }, deps)).toEqual(plain.outcome)
    expect(plain.outcome.upstreamStatus).toBe(200)
  })

  it('returns no request or response unless a preview is asked for', async () => {
    const result = await callUpstream(project(), tool('getPet'), { petId: 1 }, deps)
    expect(result).toEqual({ outcome: expect.any(Object) })
  })

  it('a rejected argument returns its message and no request', async () => {
    const result = await callUpstream(project(), tool('getPet'), { petId: 'seven' }, deps, { preview: true })
    expect(result.outcome.errorClass).toBe('VALIDATION')
    expect(result.request).toBeUndefined()
    expect(received).toHaveLength(0)
  })
})

describe('callUpstream: the request preview', () => {
  it('shows the method, URL and agent-supplied headers, and what was sent upstream matches', async () => {
    const { request } = await callUpstream(project(), tool('getPet'), { petId: 7, verbose: true, 'X-Trace': 'trace-1' }, deps, { preview: true })
    expect(request).toMatchObject({ method: 'GET', url: `${baseUrl}/pets/7?verbose=true`, headers: { 'x-trace': 'trace-1' } })
    expect(received[0]!.url).toBe('/pets/7?verbose=true')
  })

  it('never contains a bearer credential: a placeholder stands in for it', async () => {
    const result = await callUpstream(project({ type: 'BEARER', value: BEARER }), tool('getPet'), { petId: 7 }, deps, { preview: true })
    expect(result.request!.headers['authorization']).toBe('Bearer ••••')
    expect(received[0]!.headers['authorization']).toBe(`Bearer ${BEARER}`) // the real call did carry it
    expect(JSON.stringify(result.request)).not.toContain(BEARER)
    expect(JSON.stringify(result.response)).not.toContain(BEARER)
  })

  it('never contains a custom-header credential', async () => {
    const p = project({ type: 'CUSTOM_HEADER', headerName: 'X-Api-Key', value: 'hdr-secret-77aa90' })
    const { request } = await callUpstream(p, tool('getPet'), { petId: 7 }, deps, { preview: true })
    expect(request!.headers['x-api-key']).toBe('••••')
    expect(received[0]!.headers['x-api-key']).toBe('hdr-secret-77aa90')
    expect(JSON.stringify(request)).not.toContain('hdr-secret-77aa90')
  })

  it('never contains a query-parameter credential, plain or encoded, and replaces one the agent sent under that name', async () => {
    const p = project({ type: 'QUERY_PARAM', queryParamName: 'api_key', value: QUERY_SECRET })
    const { request } = await callUpstream(p, tool('listItems'), { tenant: 'acme', scope: 'all' }, deps, { preview: true })
    expect(request!.url).toBe(`${baseUrl}/tenant/items?tenant=acme&scope=all&api_key=••••`)
    const sent = new URL(received[0]!.url, 'http://x').searchParams
    expect(sent.get('api_key')).toBe(QUERY_SECRET)
    for (const form of [QUERY_SECRET, encodeURIComponent(QUERY_SECRET)]) expect(JSON.stringify(request)).not.toContain(form)
  })

  it('never contains a hidden parameter value, even a short one: it is shown as HIDDEN', async () => {
    const t = tool('listItems', { tenant: { value: 'acme' } })
    const { request } = await callUpstream(project(), t, { scope: 'all' }, deps, { preview: true })
    expect(received[0]!.url).toBe('/tenant/items?tenant=acme&scope=all') // the real call used the fixed value
    expect(request!.url).toBe(`${baseUrl}/tenant/items?tenant=HIDDEN&scope=all`)
    expect(JSON.stringify(request)).not.toContain('acme')
  })

  it('a hidden path value and a hidden body field are also replaced', async () => {
    const getPet = tool('getPet', { petId: { value: 4242 } })
    const created = tool('createPet', { label: { value: HIDDEN_LONG } })
    const a = await callUpstream(project(), getPet, {}, deps, { preview: true })
    const b = await callUpstream(project(), created, { name: 'Rex' }, deps, { preview: true })
    expect(a.request!.url).toBe(`${baseUrl}/pets/HIDDEN`)
    expect(b.request!.body).toBe('{"name":"Rex","label":"HIDDEN"}')
    expect(JSON.stringify([a.request, b.request])).not.toMatch(/4242|hidden-value/)
    expect(JSON.parse(received[1]!.body)).toEqual({ name: 'Rex', label: HIDDEN_LONG })
  })

  it('masks sensitive header names, query names and body keys like the call logs do', async () => {
    const withHeader = await callUpstream(project(), tool('getPet'), { petId: 1, api_key: 'user-typed-key-123' }, deps, { preview: true })
    expect(withHeader.request!.headers['api_key']).toBe('[MASKED]')
    expect(JSON.stringify(withHeader.request)).not.toContain('user-typed-key-123')

    const withBody = await callUpstream(project(), tool('createPet'), { name: 'Rex', password: 'hunter2-hunter2' }, deps, { preview: true })
    expect(JSON.parse(withBody.request!.body!)).toEqual({ name: 'Rex', password: '[MASKED]' })
  })

  it('is still returned when the call fails after the request was built', async () => {
    const dead = await callUpstream(project({ type: 'BEARER', value: BEARER }, 'http://127.0.0.1:1'), tool('getPet'), { petId: 1 }, deps, { preview: true })
    expect(dead.outcome.errorClass).toBe('UNREACHABLE')
    expect(dead.request).toMatchObject({ method: 'GET', headers: { authorization: 'Bearer ••••' } })
    expect(dead.response).toBeUndefined()

    const broken: ProjectConfig = { ...project({ type: 'BEARER', value: BEARER }), credential: { type: 'BEARER', headerName: null, queryParamName: null, encryptedValue: 'not-valid-ciphertext' } }
    const result = await callUpstream(broken, tool('getPet'), { petId: 1 }, deps, { preview: true })
    expect(result.outcome.errorClass).toBe('CREDENTIAL')
    expect(result.request!.headers['authorization']).toBe('Bearer ••••')
    expect(received).toHaveLength(0)
  })
})

describe('callUpstream: the response preview', () => {
  it('keeps the status, an allowlist of headers and the body', async () => {
    const { response } = await callUpstream(project(), tool('headers'), {}, deps, { preview: true })
    expect(response).toMatchObject({
      status: 200,
      headers: { 'content-type': 'application/json', 'ratelimit-remaining': '41', 'x-ratelimit-limit': '50', 'cache-control': 'no-store' },
      body: '{}',
      bodyBytes: 2,
      binary: false,
      truncated: false,
    })
    expect(Object.keys(response!.headers)).not.toContain('set-cookie')
    expect(Object.keys(response!.headers)).not.toContain('x-internal-host')
  })

  it('redacts a credential and hidden values the upstream echoes back', async () => {
    const t = tool('getPet', { 'X-Trace': { value: HIDDEN_LONG } })
    const result = await callUpstream(project({ type: 'BEARER', value: BEARER }), t, { petId: 500 }, deps, { preview: true })
    expect(result.outcome.errorClass).toBe('UPSTREAM_5XX')
    expect(result.response!.status).toBe(500)
    expect(result.response!.body).toContain(REDACTED)
    expect(result.response!.body).not.toContain(BEARER)
    expect(result.response!.body).not.toContain(HIDDEN_LONG)
  })

  it('shows only the type and size of a binary body', async () => {
    const { response } = await callUpstream(project(), tool('image'), {}, deps, { preview: true })
    expect(response).toMatchObject({ status: 200, headers: { 'content-type': 'image/png' }, bodyBytes: 8, binary: true, truncated: false })
    expect(response!.body).toBeUndefined()
  })

  it('cuts a long text body for display and says so, keeping the real size', async () => {
    const { response, outcome } = await callUpstream(project(), tool('big'), {}, deps, { preview: true })
    expect(response!.body).toHaveLength(DISPLAY_BODY_CHARS)
    expect(response).toMatchObject({ truncated: true, bodyBytes: 150_000 })
    expect(outcome.responseBytes).toBe(150_000)
  })
})
