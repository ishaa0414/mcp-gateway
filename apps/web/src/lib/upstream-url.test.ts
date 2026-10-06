import { describe, expect, it } from 'vitest'
import { isAbsoluteHttpUrl, validateUpstreamUrl } from './upstream-url'

describe('validateUpstreamUrl', () => {
  it('treats an empty or blank value as "not set"', async () => {
    expect(await validateUpstreamUrl('')).toEqual({ ok: true, url: '' })
    expect(await validateUpstreamUrl('   ')).toEqual({ ok: true, url: '' })
  })

  it('normalises: trims, drops trailing slash, query and fragment', async () => {
    expect(await validateUpstreamUrl('  https://93.184.216.34/api/v3/?a=1#x ')).toEqual({
      ok: true,
      url: 'https://93.184.216.34/api/v3',
    })
    expect(await validateUpstreamUrl('http://93.184.216.34:8080/')).toEqual({
      ok: true,
      url: 'http://93.184.216.34:8080',
    })
  })

  it('rejects relative URLs with a helpful message', async () => {
    const res = await validateUpstreamUrl('/api/v3')
    expect(res).toMatchObject({ ok: false })
    expect((res as { error: string }).error).toMatch(/absolute URL/)
  })

  it('rejects private targets', async () => {
    for (const url of ['http://127.0.0.1', 'http://169.254.169.254', 'https://10.1.2.3', 'http://localhost']) {
      expect((await validateUpstreamUrl(url)).ok).toBe(false)
    }
  })
})

describe('isAbsoluteHttpUrl', () => {
  it('only accepts absolute http(s) URLs with a host', () => {
    expect(isAbsoluteHttpUrl('https://api.example.com/v1')).toBe(true)
    expect(isAbsoluteHttpUrl('HTTP://api.example.com')).toBe(true)
    for (const bad of ['', '/api/v3', 'api.example.com', 'https://', 'ftp://x.com']) {
      expect(isAbsoluteHttpUrl(bad)).toBe(false)
    }
  })
})
