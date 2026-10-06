import { describe, it, expect } from 'vitest'
import { resolveBaseUrl } from './servers.js'

const SPEC_URL = 'https://petstore3.swagger.io/api/v3/openapi.json'

function withServer(server: Record<string, unknown> | undefined) {
  return server ? { servers: [server] } : {}
}

describe('resolveBaseUrl', () => {
  it('reports none when the spec has no servers', () => {
    expect(resolveBaseUrl({})).toEqual({ status: 'none' })
    expect(resolveBaseUrl({ servers: [] }, SPEC_URL)).toEqual({ status: 'none' })
    expect(resolveBaseUrl(withServer({ url: '  ' }), SPEC_URL)).toEqual({ status: 'none' })
  })

  it('returns an absolute URL unchanged, without a trailing slash', () => {
    expect(resolveBaseUrl(withServer({ url: 'https://api.example.com/v1/' }))).toEqual({
      status: 'resolved',
      url: 'https://api.example.com/v1',
    })
    expect(resolveBaseUrl(withServer({ url: 'https://api.example.com' }))).toEqual({
      status: 'resolved',
      url: 'https://api.example.com',
    })
  })

  it('resolves a relative URL against the spec URL (the Petstore case)', () => {
    expect(resolveBaseUrl(withServer({ url: '/api/v3' }), SPEC_URL)).toEqual({
      status: 'resolved',
      url: 'https://petstore3.swagger.io/api/v3',
    })
  })

  it('resolves path-relative and protocol-relative URLs against the spec URL', () => {
    expect(resolveBaseUrl(withServer({ url: '../v2' }), 'https://a.example.com/docs/spec.json')).toEqual({
      status: 'resolved',
      url: 'https://a.example.com/v2',
    })
    expect(resolveBaseUrl(withServer({ url: '//api.example.com/v1' }), SPEC_URL)).toEqual({
      status: 'resolved',
      url: 'https://api.example.com/v1',
    })
  })

  it('does not guess for a relative URL when the spec was uploaded', () => {
    expect(resolveBaseUrl(withServer({ url: '/api/v3' }))).toEqual({ status: 'relative', raw: '/api/v3' })
    expect(resolveBaseUrl(withServer({ url: '//api.example.com/v1' }))).toEqual({
      status: 'relative',
      raw: '//api.example.com/v1',
    })
  })

  it('substitutes server variable defaults', () => {
    const server = {
      url: 'https://{region}.api.example.com:{port}/{basePath}',
      variables: {
        region: { default: 'eu', enum: ['eu', 'us'] },
        port: { default: 8443 },
        basePath: { default: 'v2' },
      },
    }
    expect(resolveBaseUrl(withServer(server))).toEqual({
      status: 'resolved',
      url: 'https://eu.api.example.com:8443/v2',
    })
  })

  it('substitutes variables in a relative URL before resolving it', () => {
    const server = { url: '/api/{version}', variables: { version: { default: 'v3' } } }
    expect(resolveBaseUrl(withServer(server), SPEC_URL)).toMatchObject({
      status: 'resolved',
      url: 'https://petstore3.swagger.io/api/v3',
    })
  })

  it('rejects a variable that has no default', () => {
    const result = resolveBaseUrl(withServer({ url: 'https://{tenant}.example.com' }))
    expect(result).toMatchObject({ status: 'invalid' })
    expect((result as { reason: string }).reason).toContain('tenant')
  })

  it('rejects non-http(s) schemes', () => {
    for (const url of ['ftp://files.example.com', 'file:///etc/passwd', 'javascript:alert(1)']) {
      expect(resolveBaseUrl(withServer({ url }), SPEC_URL)).toMatchObject({ status: 'invalid' })
    }
  })

  it('rejects credentials embedded in the URL', () => {
    const result = resolveBaseUrl(withServer({ url: 'https://user:secret@api.example.com' }))
    expect(result).toMatchObject({ status: 'invalid' })
  })

  it('never returns a relative URL as resolved', () => {
    for (const url of ['/api/v3', 'api/v3', '../x', '//host/x', 'https://ok.example.com']) {
      for (const specUrl of [undefined, SPEC_URL]) {
        const r = resolveBaseUrl(withServer({ url }), specUrl)
        if (r.status === 'resolved') expect(r.url).toMatch(/^https?:\/\/[^/]+/)
      }
    }
  })
})
