import { describe, expect, it } from 'vitest'
import { CredentialInputSchema } from './credential-input'

const parse = (input: unknown) => CredentialInputSchema.safeParse(input)
const message = (input: unknown) => {
  const r = parse(input)
  return r.success ? '' : r.error.issues.map((i) => i.message).join(' | ')
}

describe('credential input: types', () => {
  it('accepts each kind', () => {
    expect(parse({ type: 'NONE' }).success).toBe(true)
    expect(parse({ type: 'BEARER', value: 'tok_123' }).success).toBe(true)
    expect(parse({ type: 'CUSTOM_HEADER', headerName: 'X-Api-Key', value: 'k' }).success).toBe(true)
    expect(parse({ type: 'QUERY_PARAM', queryParamName: 'api_key', value: 'k' }).success).toBe(true)
  })

  it('rejects an unknown type', () => {
    expect(parse({ type: 'BASIC', value: 'x' }).success).toBe(false)
  })

  it('ignores a value sent with NONE rather than storing it', () => {
    const r = parse({ type: 'NONE', value: 'oops' })
    expect(r.success && 'value' in r.data).toBe(false)
  })
})

describe('credential input: values', () => {
  it('treats an empty value as "keep the stored one" (undefined)', () => {
    const r = parse({ type: 'BEARER', value: '' })
    expect(r.success && r.data).toEqual({ type: 'BEARER', value: undefined })
    expect(parse({ type: 'BEARER' }).success).toBe(true)
  })

  it('trims surrounding whitespace, which is usually a paste accident', () => {
    const r = parse({ type: 'BEARER', value: '  tok_123\n' })
    expect(r.success && r.data.type === 'BEARER' && r.data.value).toBe('tok_123')
  })

  it.each([['line break inside', 'a\r\nX-Injected: 1'], ['newline inside', 'a\nb'], ['NUL', 'a\0b'], ['tab', 'a\tb'], ['DEL', 'a\x7fb']])(
    'rejects %s (header injection)',
    (_label, value) => {
      expect(message({ type: 'BEARER', value })).toMatch(/line breaks or control characters/)
    }
  )

  it('rejects a whitespace-only value and an enormous one', () => {
    expect(parse({ type: 'BEARER', value: '   ' }).success).toBe(false)
    expect(message({ type: 'BEARER', value: 'x'.repeat(2001) })).toMatch(/too long/)
  })

  it('keeps unusual but legal characters', () => {
    const value = 'p@ss w/rd+=%&?"\'\\é'
    const r = parse({ type: 'QUERY_PARAM', queryParamName: 'k', value })
    expect(r.success && r.data.type === 'QUERY_PARAM' && r.data.value).toBe(value)
  })
})

describe('credential input: header names', () => {
  it.each(['X-Api-Key', 'Authorization', 'api_key', 'X.Custom', 'x-1'])('accepts %s', (headerName) => {
    expect(parse({ type: 'CUSTOM_HEADER', headerName, value: 'v' }).success).toBe(true)
  })

  it.each(['', '  ', 'bad name', 'bad:name', 'a\r\nb', 'naïve', 'a/b', '(x)', 'a,b'])('rejects %j', (headerName) => {
    expect(parse({ type: 'CUSTOM_HEADER', headerName, value: 'v' }).success).toBe(false)
  })

  it.each(['Host', 'content-length', 'Transfer-Encoding', 'Connection', 'UPGRADE', 'te', 'Keep-Alive'])(
    'rejects %s, which the HTTP client controls',
    (headerName) => {
      expect(message({ type: 'CUSTOM_HEADER', headerName, value: 'v' })).toMatch(/set by the gateway itself/)
    }
  )

  it('requires a header name for CUSTOM_HEADER', () => {
    expect(parse({ type: 'CUSTOM_HEADER', value: 'v' }).success).toBe(false)
  })
})

describe('credential input: query parameter names', () => {
  it.each(['api_key', 'key', 'access-token', 'a.b', 'k~1'])('accepts %s', (queryParamName) => {
    expect(parse({ type: 'QUERY_PARAM', queryParamName, value: 'v' }).success).toBe(true)
  })

  it.each(['', 'a b', 'a&b=c', 'a=b', 'a#b', 'ключ', 'a?b'])('rejects %j (it would break the URL)', (queryParamName) => {
    expect(parse({ type: 'QUERY_PARAM', queryParamName, value: 'v' }).success).toBe(false)
  })

  it('requires a name for QUERY_PARAM', () => {
    expect(parse({ type: 'QUERY_PARAM', value: 'v' }).success).toBe(false)
  })
})
