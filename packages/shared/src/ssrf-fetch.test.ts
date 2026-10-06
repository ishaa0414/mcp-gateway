import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { ssrfFetch, SsrfError, isBlockedIpv4, isBlockedIpv6 } from './ssrf-fetch.js'

// ---------------------------------------------------------------------------
// Unit tests for IP validation helpers
// ---------------------------------------------------------------------------

describe('isBlockedIpv4', () => {
  it.each([
    ['0.0.0.0', true],
    ['0.255.255.255', true],
    ['10.0.0.1', true],
    ['10.255.255.255', true],
    ['100.64.0.1', true],   // CGNAT
    ['100.127.255.255', true], // CGNAT
    ['127.0.0.1', true],
    ['127.255.255.255', true],
    ['169.254.0.1', true],  // link-local / metadata
    ['169.254.169.254', true], // AWS metadata
    ['172.16.0.1', true],
    ['172.31.255.255', true],
    ['192.168.0.1', true],
    ['192.168.255.255', true],
    // Public
    ['1.1.1.1', false],
    ['8.8.8.8', false],
    ['172.32.0.1', false],  // just outside 172.16/12
    ['100.63.255.255', false], // just before CGNAT
    ['100.128.0.0', false],    // just after CGNAT
  ])('%s → %s', (ip, expected) => {
    expect(isBlockedIpv4(ip)).toBe(expected)
  })
})

describe('isBlockedIpv6', () => {
  it.each([
    ['::1', true],                    // loopback
    ['::', true],                     // unspecified
    ['fc00::1', true],                // ULA
    ['fd00::1', true],                // ULA
    ['fe80::1', true],                // link-local
    ['fec0::1', false],               // deprecated site-local – NOT in fe80::/10
    ['::ffff:127.0.0.1', true],       // IPv4-mapped loopback
    ['::ffff:10.0.0.1', true],        // IPv4-mapped private
    ['::ffff:7f00:1', true],          // IPv4-mapped hex loopback
    ['::ffff:c0a8:1', true],          // ::ffff:192.168.0.1
    ['2001:db8::1', false],           // documentation range (public)
    ['2606:4700:4700::1111', false],  // Cloudflare DNS (public)
  ])('%s → %s', (ip, expected) => {
    expect(isBlockedIpv6(ip)).toBe(expected)
  })
})

// ---------------------------------------------------------------------------
// Integration-style tests via ssrfFetch (DNS + undici mocked)
// ---------------------------------------------------------------------------

vi.mock('node:dns/promises', () => ({
  lookup: vi.fn(),
}))

vi.mock('undici', () => ({
  request: vi.fn(),
}))

import { lookup as mockLookup } from 'node:dns/promises'
import { request as mockRequest } from 'undici'

const lookup = mockLookup as ReturnType<typeof vi.fn>
const request = mockRequest as ReturnType<typeof vi.fn>

function makeBody(text: string): AsyncIterable<Buffer> {
  return {
    [Symbol.asyncIterator]() {
      let done = false
      return {
        async next() {
          if (done) return { value: undefined, done: true }
          done = true
          return { value: Buffer.from(text), done: false }
        },
      }
    },
  }
}

function okResponse(body = 'hello', status = 200) {
  return {
    statusCode: status,
    headers: { 'content-type': 'text/plain' },
    body: makeBody(body),
  }
}

function redirectResponse(location: string, status = 302) {
  return {
    statusCode: status,
    headers: { location },
    body: makeBody(''),
  }
}

beforeEach(() => {
  vi.clearAllMocks()
})

afterEach(() => {
  delete process.env.ALLOW_PRIVATE_UPSTREAMS
})

// --- Scheme enforcement ---

describe('scheme enforcement', () => {
  it('rejects ftp://', async () => {
    await expect(ssrfFetch('ftp://example.com/file')).rejects.toThrow(SsrfError)
  })

  it('rejects file://', async () => {
    await expect(ssrfFetch('file:///etc/passwd')).rejects.toThrow(SsrfError)
  })
})

// --- Public URL allowed ---

describe('public URL', () => {
  it('returns response for a public IP', async () => {
    lookup.mockResolvedValue({ address: '1.1.1.1', family: 4 })
    request.mockResolvedValue(okResponse('body text'))

    const res = await ssrfFetch('http://example.com/path')
    expect(res.status).toBe(200)
    expect(res.text()).toBe('body text')
  })
})

// --- Private IP blocking ---

describe('private IP blocking', () => {
  it.each([
    ['127.0.0.1'],
    ['10.0.0.1'],
    ['192.168.1.1'],
    ['172.16.0.1'],
    ['169.254.169.254'],
    ['100.64.0.1'],
  ])('blocks %s via URL', async (ip) => {
    // No DNS mock needed — direct IP in URL triggers validation
    await expect(ssrfFetch(`http://${ip}/path`)).rejects.toThrow(SsrfError)
  })

  it('blocks hostname that resolves to 127.0.0.1', async () => {
    lookup.mockResolvedValue({ address: '127.0.0.1', family: 4 })
    await expect(ssrfFetch('http://evil.internal/')).rejects.toThrow(SsrfError)
  })

  it('blocks hostname resolving to 10.x.x.x', async () => {
    lookup.mockResolvedValue({ address: '10.1.2.3', family: 4 })
    await expect(ssrfFetch('http://internal.corp/')).rejects.toThrow(SsrfError)
  })

  it('blocks IPv4-mapped ::ffff:127.0.0.1', async () => {
    lookup.mockResolvedValue({ address: '::ffff:127.0.0.1', family: 6 })
    await expect(ssrfFetch('http://mapped.example/')).rejects.toThrow(SsrfError)
  })

  it('blocks ::1 loopback', async () => {
    lookup.mockResolvedValue({ address: '::1', family: 6 })
    await expect(ssrfFetch('http://v6loop.example/')).rejects.toThrow(SsrfError)
  })

  it('blocks fc00::/7 ULA', async () => {
    lookup.mockResolvedValue({ address: 'fd12:3456:789a::1', family: 6 })
    await expect(ssrfFetch('http://ula.example/')).rejects.toThrow(SsrfError)
  })
})

// --- Allow private in dev mode ---

describe('ALLOW_PRIVATE_UPSTREAMS=true in development', () => {
  it('allows localhost when NODE_ENV=development and flag set', async () => {
    const origEnv = process.env.NODE_ENV
    process.env.NODE_ENV = 'development'
    process.env.ALLOW_PRIVATE_UPSTREAMS = 'true'

    lookup.mockResolvedValue({ address: '127.0.0.1', family: 4 })
    request.mockResolvedValue(okResponse('local'))

    const res = await ssrfFetch('http://localhost/')
    expect(res.status).toBe(200)

    process.env.NODE_ENV = origEnv
  })

  it('still blocks when NODE_ENV is not development', async () => {
    const origEnv = process.env.NODE_ENV
    process.env.NODE_ENV = 'production'
    process.env.ALLOW_PRIVATE_UPSTREAMS = 'true'

    lookup.mockResolvedValue({ address: '127.0.0.1', family: 4 })

    await expect(ssrfFetch('http://localhost/')).rejects.toThrow(SsrfError)
    process.env.NODE_ENV = origEnv
  })
})

// --- Redirect handling ---

describe('redirects', () => {
  it('follows a redirect to a public URL', async () => {
    lookup
      .mockResolvedValueOnce({ address: '1.1.1.1', family: 4 }) // first request
      .mockResolvedValueOnce({ address: '1.1.1.2', family: 4 }) // after redirect

    request
      .mockResolvedValueOnce(redirectResponse('http://other.example/final'))
      .mockResolvedValueOnce(okResponse('final body'))

    const res = await ssrfFetch('http://start.example/')
    expect(res.status).toBe(200)
    expect(res.text()).toBe('final body')
  })

  it('blocks redirect to private IP', async () => {
    lookup
      .mockResolvedValueOnce({ address: '1.1.1.1', family: 4 }) // first hop OK
      .mockResolvedValueOnce({ address: '192.168.1.1', family: 4 }) // redirect target blocked

    request.mockResolvedValueOnce(redirectResponse('http://internal.corp/'))

    await expect(ssrfFetch('http://safe.example/')).rejects.toThrow(SsrfError)
  })

  it('blocks redirect chain exceeding max hops', async () => {
    lookup.mockResolvedValue({ address: '1.1.1.1', family: 4 })
    request.mockResolvedValue(redirectResponse('http://example.com/loop'))

    await expect(ssrfFetch('http://example.com/')).rejects.toThrow(SsrfError)
    // 4 requests total: original + 3 redirects = exceeds MAX_REDIRECTS
    expect(request).toHaveBeenCalledTimes(MAX_REDIRECTS + 1)
  })

  it('rejects redirect to file://', async () => {
    lookup.mockResolvedValueOnce({ address: '1.1.1.1', family: 4 })
    request.mockResolvedValueOnce(redirectResponse('file:///etc/passwd'))

    await expect(ssrfFetch('http://example.com/')).rejects.toThrow(SsrfError)
  })
})

const MAX_REDIRECTS = 3
