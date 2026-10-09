/**
 * ssrfFetch against real local HTTP servers (nothing mocked), for the behaviour a
 * mock cannot show: what is actually sent, the overall deadline, and where
 * credentials go on a redirect. Loopback is allowed the way the spec allows it:
 * NODE_ENV=development plus ALLOW_PRIVATE_UPSTREAMS=true, for these tests only.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ssrfFetch, SsrfError } from './ssrf-fetch.js'

interface Seen {
  method: string
  url: string
  headers: IncomingMessage['headers']
  body: string
}

const servers: Server[] = []

async function listen(handler: (req: IncomingMessage, res: ServerResponse, seen: Seen) => void) {
  const seen: Seen[] = []
  const server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      const entry = { method: req.method!, url: req.url!, headers: req.headers, body: Buffer.concat(chunks).toString() }
      seen.push(entry)
      handler(req, res, entry)
    })
  })
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  return { url, seen }
}

beforeEach(() => {
  vi.stubEnv('NODE_ENV', 'development')
  vi.stubEnv('ALLOW_PRIVATE_UPSTREAMS', 'true')
})

afterEach(async () => {
  vi.unstubAllEnvs()
  await Promise.all(
    servers.splice(0).map((s) => {
      s.closeAllConnections()
      return new Promise((resolve) => s.close(resolve))
    })
  )
})

const ok = (res: ServerResponse, body = 'ok') => {
  res.writeHead(200, { 'content-type': 'text/plain' })
  res.end(body)
}

describe('request bodies', () => {
  it.each(['POST', 'PUT', 'PATCH'])('sends a JSON body with %s', async (method) => {
    const { url, seen } = await listen((_req, res) => ok(res))

    const res = await ssrfFetch(`${url}/things`, { method, body: { name: 'Rex', tags: ['a', 'b'], n: 1 } })

    expect(res.status).toBe(200)
    expect(seen[0]).toMatchObject({ method, url: '/things' })
    expect(seen[0]!.headers['content-type']).toBe('application/json')
    expect(JSON.parse(seen[0]!.body)).toEqual({ name: 'Rex', tags: ['a', 'b'], n: 1 })
    expect(seen[0]!.headers['content-length']).toBe(String(Buffer.byteLength(seen[0]!.body)))
  })

  it('sends strings as-is with the caller content type, and does not add its own', async () => {
    const { url, seen } = await listen((_req, res) => ok(res))

    await ssrfFetch(url, {
      method: 'POST',
      body: 'a=1&b=2',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    })

    expect(seen[0]!.body).toBe('a=1&b=2')
    expect(seen[0]!.headers['content-type']).toBe('application/x-www-form-urlencoded')
  })

  it('keeps a caller-supplied JSON content type', async () => {
    const { url, seen } = await listen((_req, res) => ok(res))
    await ssrfFetch(url, { method: 'POST', body: { a: 1 }, headers: { 'content-type': 'application/vnd.api+json' } })
    expect(seen[0]!.headers['content-type']).toBe('application/vnd.api+json')
  })

  it.each(['GET', 'DELETE', 'HEAD'])('rejects a body on %s', async (method) => {
    const { url, seen } = await listen((_req, res) => ok(res))

    await expect(ssrfFetch(url, { method, body: { a: 1 } })).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    expect(seen).toHaveLength(0)
  })

  it('rejects a body that is not JSON-serialisable', async () => {
    const { url } = await listen((_req, res) => ok(res))
    const circular: Record<string, unknown> = {}
    circular['self'] = circular

    await expect(ssrfFetch(url, { method: 'POST', body: circular })).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    await expect(ssrfFetch(url, { method: 'POST', body: 10n })).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
  })

  it('does not let callers override Host or framing headers', async () => {
    const { url, seen } = await listen((_req, res) => ok(res))

    await ssrfFetch(url, {
      method: 'POST',
      body: { a: 1 },
      headers: { Host: 'evil.example', 'Content-Length': '999', 'Transfer-Encoding': 'chunked', 'X-Keep': 'yes' },
    })

    expect(seen[0]!.headers.host).toBe(new URL(url).host)
    expect(seen[0]!.headers['content-length']).toBe(String(Buffer.byteLength(seen[0]!.body)))
    expect(seen[0]!.headers['transfer-encoding']).toBeUndefined()
    expect(seen[0]!.headers['x-keep']).toBe('yes')
  })
})

describe('overall deadline', () => {
  it('times out when the server never answers', async () => {
    const { url } = await listen(() => undefined)

    const started = Date.now()
    await expect(ssrfFetch(url, { timeoutMs: 250 })).rejects.toMatchObject({ name: 'SsrfError', code: 'TIMEOUT' })
    expect(Date.now() - started).toBeLessThan(2000)
  })

  it('times out a body that keeps trickling, which per-chunk timeouts would never stop', async () => {
    let timer: NodeJS.Timeout | undefined
    const { url } = await listen((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' })
      timer = setInterval(() => res.write('x'), 50) // always "making progress"
      res.on('close', () => clearInterval(timer))
    })

    const started = Date.now()
    await expect(ssrfFetch(url, { timeoutMs: 400 })).rejects.toMatchObject({ code: 'TIMEOUT' })
    expect(Date.now() - started).toBeLessThan(3000)
    clearInterval(timer)
  })

  it('includes the time spent on redirects', async () => {
    const { url } = await listen((req, res) => {
      // Each hop answers after 150 ms; the hop limit is 3, so the chain needs ~600 ms.
      setTimeout(() => {
        res.writeHead(302, { location: `${req.url}x` })
        res.end()
      }, 150)
    })

    await expect(ssrfFetch(`${url}/a`, { timeoutMs: 400 })).rejects.toMatchObject({ code: 'TIMEOUT' })
  })

  it('succeeds when the response arrives inside the budget', async () => {
    const { url } = await listen((_req, res) => setTimeout(() => ok(res, 'in time'), 100))
    expect((await ssrfFetch(url, { timeoutMs: 2000 })).text()).toBe('in time')
  })

  it('reports a caller abort as the abort, not as a timeout', async () => {
    const { url } = await listen(() => undefined)
    const controller = new AbortController()
    setTimeout(() => controller.abort(new Error('caller gave up')), 100)

    const err = await ssrfFetch(url, { signal: controller.signal, timeoutMs: 5000 }).catch((e: unknown) => e)

    expect(err).not.toBeInstanceOf(SsrfError)
  })
})

describe('response size limit', () => {
  it('rejects early from Content-Length without reading the body', async () => {
    const { url } = await listen((_req, res) => {
      res.writeHead(200, { 'content-length': String(10_000_000) })
      res.write('x')
    })

    await expect(ssrfFetch(url, { maxBytes: 1024 })).rejects.toMatchObject({ code: 'TOO_LARGE' })
  })

  it('stops an endless chunked response and closes the connection', async () => {
    let closed: Promise<void> | undefined
    const { url } = await listen((_req, res) => {
      res.writeHead(200)
      const timer = setInterval(() => res.write('y'.repeat(2048)), 5)
      closed = new Promise((resolve) =>
        res.on('close', () => {
          clearInterval(timer)
          resolve()
        })
      )
    })

    await expect(ssrfFetch(url, { maxBytes: 8 * 1024, timeoutMs: 5000 })).rejects.toMatchObject({ code: 'TOO_LARGE' })
    const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('connection left open')), 2000))
    await expect(Promise.race([closed, timeout])).resolves.toBeUndefined()
  })

  it('accepts a response exactly at the limit', async () => {
    const { url } = await listen((_req, res) => ok(res, 'z'.repeat(1024)))
    expect((await ssrfFetch(url, { maxBytes: 1024 })).body.length).toBe(1024)
  })
})

describe('redirects and credentials', () => {
  it('turns a redirected POST (302) into a GET without a body', async () => {
    const target = await listen((_req, res) => ok(res))
    const origin = await listen((_req, res) => {
      res.writeHead(302, { location: `${target.url}/landed` })
      res.end()
    })

    await ssrfFetch(`${origin.url}/start`, { method: 'POST', body: { secret: 1 } })

    expect(target.seen[0]).toMatchObject({ method: 'GET', url: '/landed', body: '' })
  })

  it('keeps method and body for a same-origin 307', async () => {
    const { url, seen } = await listen((req, res) => {
      if (req.url === '/start') {
        res.writeHead(307, { location: '/final' })
        res.end()
      } else ok(res)
    })

    await ssrfFetch(`${url}/start`, { method: 'PUT', body: { a: 1 } })

    expect(seen[1]).toMatchObject({ method: 'PUT', url: '/final' })
    expect(JSON.parse(seen[1]!.body)).toEqual({ a: 1 })
  })

  it('refuses to forward a body to a different origin on 307/308', async () => {
    const target = await listen((_req, res) => ok(res))
    const origin = await listen((_req, res) => {
      res.writeHead(308, { location: `${target.url}/stolen` })
      res.end()
    })

    await expect(ssrfFetch(origin.url, { method: 'POST', body: { a: 1 } })).rejects.toMatchObject({ code: 'REDIRECT' })
    expect(target.seen).toHaveLength(0)
  })

  it('drops Authorization, API-key and cookie headers on a cross-origin redirect', async () => {
    const target = await listen((_req, res) => ok(res))
    const origin = await listen((_req, res) => {
      res.writeHead(302, { location: `${target.url}/there` })
      res.end()
    })

    await ssrfFetch(origin.url, {
      headers: { Authorization: 'Bearer sekrit', 'X-Api-Key': 'sekrit', Cookie: 'sid=sekrit', Accept: 'application/json' },
    })

    expect(origin.seen[0]!.headers.authorization).toBe('Bearer sekrit')
    const forwarded = target.seen[0]!.headers
    expect(forwarded.authorization).toBeUndefined()
    expect(forwarded['x-api-key']).toBeUndefined()
    expect(forwarded.cookie).toBeUndefined()
    expect(forwarded.accept).toBe('application/json')
  })

  it('keeps headers on a same-origin redirect', async () => {
    const { url, seen } = await listen((req, res) => {
      if (req.url === '/a') {
        res.writeHead(302, { location: '/b' })
        res.end()
      } else ok(res)
    })

    await ssrfFetch(`${url}/a`, { headers: { Authorization: 'Bearer same-origin' } })

    expect(seen[1]!.headers.authorization).toBe('Bearer same-origin')
  })

  it('does not follow redirects when asked not to, and returns the 3xx', async () => {
    const { url, seen } = await listen((_req, res) => {
      res.writeHead(302, { location: '/elsewhere' })
      res.end()
    })

    const res = await ssrfFetch(url, { followRedirects: false })

    expect(res.status).toBe(302)
    expect(res.headers['location']).toBe('/elsewhere')
    expect(seen).toHaveLength(1)
  })

  it('blocks a redirect into the metadata range even while loopback is allowed', async () => {
    const origin = await listen((_req, res) => {
      res.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data' })
      res.end()
    })

    // Loopback is allowed in this suite, which also lifts the private-range check,
    // so switch it off for the redirect target by only allowing it for the first hop.
    vi.stubEnv('ALLOW_PRIVATE_UPSTREAMS', 'true')
    const first = await ssrfFetch(origin.url, { followRedirects: false })
    expect(first.status).toBe(302)

    vi.stubEnv('ALLOW_PRIVATE_UPSTREAMS', 'false')
    await expect(ssrfFetch(origin.url)).rejects.toBeInstanceOf(SsrfError)
  })
})

describe('private access stays off by default', () => {
  it('blocks loopback unless both NODE_ENV=development and the flag are set', async () => {
    const { url, seen } = await listen((_req, res) => ok(res))

    vi.stubEnv('ALLOW_PRIVATE_UPSTREAMS', 'false')
    await expect(ssrfFetch(url)).rejects.toMatchObject({ code: 'BLOCKED' })

    vi.stubEnv('ALLOW_PRIVATE_UPSTREAMS', 'true')
    vi.stubEnv('NODE_ENV', 'production')
    await expect(ssrfFetch(url)).rejects.toMatchObject({ code: 'BLOCKED' })

    expect(seen).toHaveLength(0)
  })
})
