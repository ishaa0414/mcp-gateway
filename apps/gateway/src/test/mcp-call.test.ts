import { db } from '@mcp-gateway/db'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  cleanupFixtures,
  createFixture,
  json,
  rpc,
  startGateway,
  startUpstream,
  textOf,
  type Fixture,
  type MockUpstream,
  type RunningGateway,
} from './harness.js'

const BEARER_SECRET = 'tok-bearer-4f9a7c21'
const HEADER_SECRET = 'hdr-secret-77aa90'
const QUERY_SECRET = 'qry secret/77+aa=90' // characters that get encoded in a URL

let gateway: RunningGateway
let upstream: MockUpstream
let base: Fixture
let bearer: Fixture
let header: Fixture
let query: Fixture
let hidden: Fixture
let noBase: Fixture
let deadHost: Fixture

beforeAll(async () => {
  vi.stubEnv('NODE_ENV', 'development')
  vi.stubEnv('ALLOW_PRIVATE_UPSTREAMS', 'true')

  upstream = await startUpstream((req, res, rec) => {
    const url = new URL(req.url!, 'http://upstream')
    const path = url.pathname

    if (path === '/pets' && req.method === 'POST') return json(res, { created: JSON.parse(rec.body) }, 201)
    if (path === '/pets') return json(res, { pets: [], search: url.search })
    if (path === '/pets/404') return json(res, { error: 'no such pet' }, 404)
    if (path === '/pets/500') {
      // A badly behaved upstream that echoes the request back inside its error.
      return json(
        res,
        { error: 'upstream exploded', authorization: req.headers['authorization'], apiKey: req.headers['x-api-key'], url: req.url },
        500
      )
    }
    if (path === '/pets/418') {
      res.writeHead(418, { 'content-type': 'text/plain' })
      return res.end('x'.repeat(5000))
    }
    if (/^\/pets\/\d+$/.test(path)) return json(res, { id: Number(path.split('/')[2]), search: url.search })
    if (path.startsWith('/things/')) return json(res, { updated: path, body: JSON.parse(rec.body) })
    if (path === '/tenant/items') return json(res, { search: url.search })
    if (path === '/slow') return // never answers
    if (path === '/big') {
      res.writeHead(200, { 'content-type': 'text/plain' })
      return res.end('y'.repeat(200 * 1024))
    }
    if (path === '/image') {
      res.writeHead(200, { 'content-type': 'image/png' })
      return res.end(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3]))
    }
    if (path === '/empty') {
      res.writeHead(204)
      return res.end()
    }
    if (path === '/moved') {
      res.writeHead(302, { location: '/elsewhere?token=in-the-location' })
      return res.end()
    }
    return json(res, { error: 'not found' }, 404)
  })
  gateway = await startGateway()

  base = await createFixture({ upstreamBaseUrl: upstream.url })
  bearer = await createFixture({ upstreamBaseUrl: upstream.url, credential: { type: 'BEARER', value: BEARER_SECRET } })
  header = await createFixture({
    upstreamBaseUrl: upstream.url,
    credential: { type: 'CUSTOM_HEADER', headerName: 'X-Api-Key', value: HEADER_SECRET },
  })
  query = await createFixture({
    upstreamBaseUrl: upstream.url,
    credential: { type: 'QUERY_PARAM', queryParamName: 'api_key', value: QUERY_SECRET },
  })
  hidden = await createFixture({
    upstreamBaseUrl: upstream.url,
    hidden: { listTenantItems: { tenant: { value: 'acme' } }, createPet: { tag: { value: 'house' } } },
  })
  noBase = await createFixture({ upstreamBaseUrl: '' })
  deadHost = await createFixture({ upstreamBaseUrl: 'http://127.0.0.1:1' })
})

afterAll(async () => {
  await gateway.close()
  await upstream.close()
  await cleanupFixtures()
  vi.unstubAllEnvs()
})

beforeEach(() => {
  upstream.requests.length = 0
  vi.stubEnv('NODE_ENV', 'development')
  vi.stubEnv('ALLOW_PRIVATE_UPSTREAMS', 'true')
})

/** Call a tool over raw JSON-RPC and return the tool result (or the JSON-RPC error). */
async function call(f: Fixture, name: string, args: object = {}, gw: RunningGateway = gateway) {
  const res = await rpc(gw.mcpUrl(f.slug), f.apiKey, 'tools/call', { name, arguments: args })
  expect(res.status).toBe(200)
  return res.body
}
const resultOf = (body: Record<string, any>) => body['result'] as { isError?: boolean; content: Array<{ type: string; text: string }> } // eslint-disable-line @typescript-eslint/no-explicit-any
const lastRequest = () => upstream.requests[upstream.requests.length - 1]!

describe('happy paths', () => {
  it('GET with path, query and header parameters', async () => {
    const result = resultOf(await call(base, 'getPet', { petId: 12, verbose: true, 'X-Trace': 'trace-1' }))

    expect(result.isError).toBeUndefined()
    expect(JSON.parse(textOf(result))).toEqual({ id: 12, search: '?verbose=true' })
    expect(lastRequest()).toMatchObject({ method: 'GET', url: '/pets/12?verbose=true' })
    expect(lastRequest().headers['x-trace']).toBe('trace-1')
  })

  it('repeats array query parameters', async () => {
    await call(base, 'listPets', { limit: 5, tag: ['a', 'b'] })
    expect(lastRequest().url).toBe('/pets?limit=5&tag=a&tag=b')
  })

  it('POST with a JSON body', async () => {
    const result = resultOf(await call(base, 'createPet', { name: 'Rex', tag: 'dog' }))

    expect(result.isError).toBeUndefined()
    expect(JSON.parse(textOf(result))).toEqual({ created: { name: 'Rex', tag: 'dog' } })
    expect(lastRequest()).toMatchObject({ method: 'POST', url: '/pets' })
    expect(lastRequest().headers['content-type']).toBe('application/json')
  })

  it('maps renamed arguments back to the right place (path id vs body id)', async () => {
    const result = resultOf(await call(base, 'updateThing', { id: 3, body_id: 'b-9', name: 'n' }))

    expect(JSON.parse(textOf(result))).toEqual({ updated: '/things/3', body: { id: 'b-9', name: 'n' } })
  })

  it('reports an empty response plainly', async () => {
    const result = resultOf(await call(base, 'emptyThing'))
    expect(result.isError).toBeUndefined()
    expect(textOf(result)).toBe('OK (HTTP 204, empty response)')
  })

  it('does not dump binary responses into the conversation', async () => {
    const result = resultOf(await call(base, 'image'))
    expect(result.isError).toBeUndefined()
    expect(textOf(result)).toMatch(/binary \(image\/png, 8 bytes\)/)
  })
})

describe('hidden parameters', () => {
  it('injects the fixed value', async () => {
    await call(hidden, 'listTenantItems', { q: 'x' })
    expect(lastRequest().url).toBe('/tenant/items?tenant=acme&q=x')
  })

  it('works when the agent supplies nothing else', async () => {
    const result = resultOf(await call(hidden, 'listTenantItems', {}))
    expect(result.isError).toBeUndefined()
    expect(lastRequest().url).toBe('/tenant/items?tenant=acme')
  })

  it('discards whatever the agent sends for a hidden parameter', async () => {
    await call(hidden, 'listTenantItems', { tenant: 'evil-corp', q: 'x' })

    expect(lastRequest().url).toBe('/tenant/items?tenant=acme&q=x')
    expect(JSON.stringify(upstream.requests)).not.toContain('evil-corp')
  })

  it('injects hidden body fields and still lets the agent fill the rest', async () => {
    await call(hidden, 'createPet', { name: 'Rex', tag: 'agent-wanted-this' })

    expect(JSON.parse(lastRequest().body)).toEqual({ name: 'Rex', tag: 'house' })
  })
})

describe('upstream credentials', () => {
  it('bearer token goes in the Authorization header', async () => {
    await call(bearer, 'getPet', { petId: 1 })
    expect(lastRequest().headers['authorization']).toBe(`Bearer ${BEARER_SECRET}`)
  })

  it('custom header', async () => {
    await call(header, 'getPet', { petId: 1 })
    expect(lastRequest().headers['x-api-key']).toBe(HEADER_SECRET)
    expect(lastRequest().headers['authorization']).toBeUndefined()
  })

  it('query parameter, encoded and appended after the tool parameters', async () => {
    await call(query, 'getPet', { petId: 1, verbose: true })

    const url = new URL(lastRequest().url, 'http://x')
    expect(url.searchParams.get('verbose')).toBe('true')
    expect(url.searchParams.getAll('api_key')).toEqual([QUERY_SECRET])
  })

  it('no credential means no credential headers', async () => {
    await call(base, 'getPet', { petId: 1 })
    expect(lastRequest().headers['authorization']).toBeUndefined()
    expect(lastRequest().headers['x-api-key']).toBeUndefined()
  })

  it('stores credentials encrypted, not as plaintext', async () => {
    const row = await db.upstreamCredential.findUniqueOrThrow({ where: { projectId: bearer.projectId } })
    expect(row.encryptedValue).toBeTruthy()
    expect(row.encryptedValue).not.toContain(BEARER_SECRET)
  })

  it.each([
    ['bearer', () => bearer, BEARER_SECRET],
    ['custom header', () => header, HEADER_SECRET],
    ['query parameter', () => query, QUERY_SECRET],
  ])('never leaks a %s credential, even when the upstream echoes it in an error', async (_label, fixture, secret) => {
    const body = await call(fixture(), 'getPet', { petId: 500 })
    const result = resultOf(body)

    expect(result.isError).toBe(true)
    expect(textOf(result)).toContain('HTTP 500')
    expect(textOf(result)).toContain('[REDACTED]')
    // Not in the result, not in any encoding, and not anywhere in the whole response.
    const everything = JSON.stringify(body)
    for (const form of [secret, encodeURIComponent(secret), Buffer.from(secret).toString('base64')]) {
      expect(everything).not.toContain(form)
    }
  })

  it('does not put the credential or the URL in the error when the upstream is unreachable', async () => {
    const withSecret = await createFixture({
      upstreamBaseUrl: 'http://127.0.0.1:1',
      credential: { type: 'QUERY_PARAM', queryParamName: 'api_key', value: 'sekrit-value-1234' },
    })

    const body = await call(withSecret, 'getPet', { petId: 1 })

    expect(resultOf(body).isError).toBe(true)
    expect(textOf(resultOf(body))).toBe('Could not reach the upstream API.')
    expect(JSON.stringify(body)).not.toContain('sekrit-value-1234')
    expect(JSON.stringify(body)).not.toContain('127.0.0.1')
  })

  it('reports a clear error when the stored credential cannot be decrypted', async () => {
    await db.upstreamCredential.update({ where: { projectId: bearer.projectId }, data: { encryptedValue: 'garbage' } })
    await db.project.update({ where: { id: bearer.projectId }, data: { name: 'touch' } })
    await gateway.redis.del(`mcp:cfg:${bearer.slug}`)

    const result = resultOf(await call(bearer, 'getPet', { petId: 1 }))

    expect(result.isError).toBe(true)
    expect(textOf(result)).toMatch(/credential could not be loaded/)
    expect(upstream.requests).toHaveLength(0)
  })
})

describe('argument validation', () => {
  it('rejects missing required arguments without calling the upstream', async () => {
    const result = resultOf(await call(base, 'getPet', {}))

    expect(result.isError).toBe(true)
    expect(textOf(result)).toMatch(/Invalid arguments for "getPet".*petId/)
    expect(upstream.requests).toHaveLength(0)
  })

  it('rejects wrong types without calling the upstream', async () => {
    const result = resultOf(await call(base, 'getPet', { petId: 'seven', verbose: 'yes' }))

    expect(result.isError).toBe(true)
    expect(textOf(result)).toMatch(/must be (integer|boolean)/)
    expect(upstream.requests).toHaveLength(0)
  })

  it('does not forward arguments the schema does not define', async () => {
    await call(base, 'getPet', { petId: 1, injected: 'x', 'x-admin': 'true' })

    expect(lastRequest().url).toBe('/pets/1')
    expect(lastRequest().headers['x-admin']).toBeUndefined()
  })

  it('says so when the project has no upstream base URL', async () => {
    const result = resultOf(await call(noBase, 'getPet', { petId: 1 }))
    expect(result.isError).toBe(true)
    expect(textOf(result)).toMatch(/no upstream base URL/)
  })
})

describe('upstream failures become tool errors, not crashes', () => {
  it('404 → isError with the status and the upstream body', async () => {
    const result = resultOf(await call(base, 'getPet', { petId: 404 }))

    expect(result.isError).toBe(true)
    expect(textOf(result)).toContain('HTTP 404 Not Found')
    expect(textOf(result)).toContain('no such pet')
  })

  it('500 → isError', async () => {
    const result = resultOf(await call(base, 'getPet', { petId: 500 }))
    expect(result.isError).toBe(true)
    expect(textOf(result)).toContain('HTTP 500 Internal Server Error')
  })

  it('truncates a very long error body', async () => {
    const result = resultOf(await call(base, 'getPet', { petId: 418 }))
    expect(textOf(result).length).toBeLessThan(2200)
    expect(textOf(result)).toContain('[truncated]')
  })

  it('the gateway keeps serving after failures', async () => {
    await call(base, 'getPet', { petId: 500 })
    const result = resultOf(await call(base, 'getPet', { petId: 5 }))
    expect(result.isError).toBeUndefined()
  })

  it('an unreachable upstream → isError with fixed wording', async () => {
    const result = resultOf(await call(deadHost, 'getPet', { petId: 1 }))
    expect(result.isError).toBe(true)
    expect(textOf(result)).toBe('Could not reach the upstream API.')
  })

  it('a slow upstream → timeout error within the deadline', async () => {
    const fast = await startGateway({ config: { toolTimeoutMs: 400 } })
    try {
      const started = Date.now()
      const result = resultOf(await call(base, 'slow', {}, fast))

      expect(result.isError).toBe(true)
      expect(textOf(result)).toMatch(/did not respond within/)
      expect(Date.now() - started).toBeLessThan(4000)
    } finally {
      await fast.close()
    }
  })

  it('an oversized response → isError naming the limit, and the gateway survives it', async () => {
    const result = resultOf(await call(base, 'big'))

    expect(result.isError).toBe(true)
    expect(textOf(result)).toBe('The upstream response is larger than the 64 KB limit.')
    expect(resultOf(await call(base, 'getPet', { petId: 1 })).isError).toBeUndefined()
  })

  it('does not follow redirects, and does not echo the Location', async () => {
    const result = resultOf(await call(base, 'moved'))

    expect(result.isError).toBe(true)
    expect(textOf(result)).toMatch(/redirect \(HTTP 302\)/)
    expect(textOf(result)).not.toContain('in-the-location')
    expect(upstream.requests).toHaveLength(1)
  })
})

describe('private upstreams are blocked unless explicitly allowed', () => {
  it('refuses a loopback upstream when the flag is off, and never contacts it', async () => {
    vi.stubEnv('ALLOW_PRIVATE_UPSTREAMS', 'false')

    const result = resultOf(await call(base, 'getPet', { petId: 1 }))

    expect(result.isError).toBe(true)
    expect(textOf(result)).toMatch(/upstream host is not allowed/)
    expect(upstream.requests).toHaveLength(0)
  })

  it('still refuses in production even if the flag is set', async () => {
    vi.stubEnv('NODE_ENV', 'production')
    vi.stubEnv('ALLOW_PRIVATE_UPSTREAMS', 'true')

    const result = resultOf(await call(base, 'getPet', { petId: 1 }))

    expect(result.isError).toBe(true)
    expect(upstream.requests).toHaveLength(0)
  })

  it.each(['http://169.254.169.254', 'http://10.0.0.5', 'http://[::1]:9'])('refuses %s', async (target) => {
    vi.stubEnv('ALLOW_PRIVATE_UPSTREAMS', 'false')
    const fx = await createFixture({ upstreamBaseUrl: target })

    const result = resultOf(await call(fx, 'getPet', { petId: 1 }))

    expect(result.isError).toBe(true)
    expect(textOf(result)).toMatch(/not allowed/)
  })
})

describe('tools that are not served', () => {
  it.each([
    ['a disabled tool', 'deletePet'],
    ['a tool removed from the spec', 'moved'],
    ['a tool that never existed', 'nope'],
  ])('%s is an unknown tool (a protocol error, same answer for all three)', async (_label, name) => {
    const fx = await createFixture({ upstreamBaseUrl: upstream.url, disabled: ['deletePet'], removed: ['moved'] })

    const body = await call(fx, name, {})

    expect(body['error']).toMatchObject({ code: -32602, message: `Unknown tool: ${name}` })
    expect(upstream.requests).toHaveLength(0)
  })
})
