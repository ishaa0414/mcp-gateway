import { describe, it, expect, afterEach, vi } from 'vitest'
import { assertPublicHttpUrl, SsrfError } from './ssrf-fetch.js'

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('assertPublicHttpUrl', () => {
  it('accepts a public IP literal over http and https', async () => {
    expect((await assertPublicHttpUrl('https://93.184.216.34/api/v3')).pathname).toBe('/api/v3')
    expect((await assertPublicHttpUrl('http://93.184.216.34:8080')).port).toBe('8080')
  })

  it.each([
    ['loopback', 'http://127.0.0.1:3000'],
    ['cloud metadata', 'http://169.254.169.254/latest/meta-data'],
    ['RFC 1918 (10/8)', 'https://10.0.0.5'],
    ['RFC 1918 (192.168/16)', 'https://192.168.1.10'],
    ['CGNAT', 'https://100.64.0.1'],
    ['IPv6 loopback', 'http://[::1]:3000'],
    ['IPv4-mapped IPv6 loopback', 'http://[::ffff:127.0.0.1]'],
    ['IPv6 ULA', 'http://[fd00::1]'],
  ])('blocks %s', async (_label, url) => {
    await expect(assertPublicHttpUrl(url)).rejects.toBeInstanceOf(SsrfError)
  })

  it('blocks a hostname that resolves to loopback', async () => {
    await expect(assertPublicHttpUrl('http://localhost:3000')).rejects.toThrow(/blocked/i)
  })

  it('rejects relative URLs, with a message that says what is needed', async () => {
    for (const url of ['/api/v3', 'api/v3', '//host/api', '']) {
      await expect(assertPublicHttpUrl(url)).rejects.toThrow(/absolute URL/)
    }
  })

  it('rejects non-http(s) protocols', async () => {
    for (const url of ['ftp://93.184.216.34', 'file:///etc/passwd', 'gopher://93.184.216.34']) {
      await expect(assertPublicHttpUrl(url)).rejects.toThrow(/protocol/i)
    }
  })

  it('rejects embedded credentials', async () => {
    await expect(assertPublicHttpUrl('https://user:pw@93.184.216.34')).rejects.toThrow(/username or password/)
  })

  it('reports an unresolvable host as an SsrfError', async () => {
    await expect(assertPublicHttpUrl('https://does-not-exist.invalid')).rejects.toThrow(/Could not resolve host/)
  })

  it('allows private targets only when explicitly enabled in development', async () => {
    vi.stubEnv('NODE_ENV', 'development')
    vi.stubEnv('ALLOW_PRIVATE_UPSTREAMS', 'true')
    await expect(assertPublicHttpUrl('http://127.0.0.1:3000')).resolves.toBeInstanceOf(URL)

    vi.stubEnv('NODE_ENV', 'production')
    await expect(assertPublicHttpUrl('http://127.0.0.1:3000')).rejects.toBeInstanceOf(SsrfError)
  })
})
