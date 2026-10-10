/**
 * One scenario per way a tool call can end, each against a project whose upstream credential
 * is a query parameter. That is the dangerous case: the secret is appended to the URL the
 * gateway calls, and upstream errors, redirects and the SDK's own messages all tend to echo URLs.
 * The log tests run every scenario and assert the secret is nowhere in what gets stored or queued.
 */
import { db } from '@mcp-gateway/db'
import type { LogErrorClass } from '@mcp-gateway/shared'
import { vi } from 'vitest'
import { createFixture, json, rpc, type Fixture, type RunningGateway } from './harness.js'

/** Has characters that change when URL-encoded, and a core that does not, so partial leaks show up too. */
export const SECRET = 'Zq9sECr3t 77/aa+90='
export const SECRET_CORE = 'Zq9sECr3t'

export const secretForms = (): string[] => [
  SECRET,
  encodeURIComponent(SECRET),
  SECRET_CORE,
  Buffer.from(SECRET).toString('base64'),
  Buffer.from(SECRET).toString('base64').replace(/=+$/, ''),
  Buffer.from(SECRET).toString('base64url'),
]

/** The mock upstream every scenario talks to. It echoes the request URL back, like a careless real API. */
export function scenarioUpstream(req: { url?: string }, res: import('node:http').ServerResponse): unknown {
  const url = new URL(req.url!, 'http://upstream')
  const path = url.pathname
  if (path === '/pets') return json(res, { pets: [], echoedUrl: req.url })
  if (path === '/pets/404') return json(res, { error: 'no such pet', echoedUrl: req.url }, 404)
  if (path === '/pets/500') return json(res, { error: 'upstream exploded', echoedUrl: req.url }, 500)
  if (path === '/slow') return // never answers
  if (path === '/big') {
    res.writeHead(200, { 'content-type': 'text/plain' })
    return res.end('y'.repeat(200 * 1024))
  }
  if (path === '/moved') {
    res.writeHead(302, { location: `/elsewhere${url.search}` }) // the credential rides along in Location
    return res.end()
  }
  json(res, { error: 'not found', echoedUrl: req.url }, 404)
}

export interface ScenarioContext {
  upstreamUrl: string
  gateway: RunningGateway
}

export interface Scenario {
  name: string
  /** The class the failing call must be logged with; null for a success. */
  errorClass: LogErrorClass | null
  /** Makes the calls; returns the project whose log is checked. */
  run(ctx: ScenarioContext): Promise<Fixture>
}

const withQueryCredential = (upstreamBaseUrl: string) =>
  createFixture({ upstreamBaseUrl, credential: { type: 'QUERY_PARAM', queryParamName: 'api_key', value: SECRET } })

async function call(ctx: ScenarioContext, fx: Fixture, name: string, args: object = {}) {
  const res = await rpc(ctx.gateway.mcpUrl(fx.slug), fx.apiKey, 'tools/call', { name, arguments: args })
  return res
}

const simple = (name: string, errorClass: LogErrorClass | null, tool: string, args: object): Scenario => ({
  name,
  errorClass,
  async run(ctx) {
    const fx = await withQueryCredential(ctx.upstreamUrl)
    await call(ctx, fx, tool, args)
    return fx
  },
})

export const scenarios: Scenario[] = [
  simple('success', null, 'listPets', { limit: 3 }),
  simple('invalid arguments', 'VALIDATION', 'getPet', { petId: 'not-a-number' }),
  simple('unknown tool', 'UNKNOWN_TOOL', 'doesNotExist', {}),
  simple('a header the request builder refuses', 'REQUEST_BUILD', 'getPet', { petId: 1, 'X-Trace': 'a\r\nb' }),
  simple('upstream 404', 'UPSTREAM_4XX', 'getPet', { petId: 404 }),
  simple('upstream 500 that echoes the URL', 'UPSTREAM_5XX', 'getPet', { petId: 500 }),
  simple('redirect whose Location carries the credential', 'REDIRECT', 'moved', {}),
  simple('upstream that never answers', 'TIMEOUT', 'slow', {}),
  simple('response over the size cap', 'TOO_LARGE', 'big', {}),
  {
    name: 'no upstream base URL',
    errorClass: 'NO_BASE_URL',
    async run(ctx) {
      const fx = await withQueryCredential('')
      await call(ctx, fx, 'listPets')
      return fx
    },
  },
  {
    name: 'credential that cannot be decrypted',
    errorClass: 'CREDENTIAL',
    async run(ctx) {
      const fx = await withQueryCredential(ctx.upstreamUrl)
      await db.upstreamCredential.update({ where: { projectId: fx.projectId }, data: { encryptedValue: 'not-a-valid-ciphertext' } })
      await call(ctx, fx, 'listPets')
      return fx
    },
  },
  {
    name: 'upstream host that is not allowed',
    errorClass: 'BLOCKED',
    async run(ctx) {
      const fx = await withQueryCredential('http://10.0.0.5')
      vi.stubEnv('ALLOW_PRIVATE_UPSTREAMS', 'false')
      try {
        await call(ctx, fx, 'listPets')
      } finally {
        vi.stubEnv('ALLOW_PRIVATE_UPSTREAMS', 'true')
      }
      return fx
    },
  },
  {
    name: 'upstream that cannot be reached',
    errorClass: 'UNREACHABLE',
    async run(ctx) {
      const fx = await withQueryCredential('http://127.0.0.1:1')
      await call(ctx, fx, 'listPets')
      return fx
    },
  },
  {
    name: 'call turned away by the rate limiter',
    errorClass: 'RATE_LIMITED',
    async run(ctx) {
      const fx = await withQueryCredential(ctx.upstreamUrl)
      await db.apiKey.update({ where: { id: fx.apiKeyId }, data: { rateLimitPerMin: 1 } })
      await call(ctx, fx, 'listPets')
      await call(ctx, fx, 'listPets') // over the limit
      return fx
    },
  },
]
