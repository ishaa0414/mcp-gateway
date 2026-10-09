import { describe, expect, it } from 'vitest'
import { redactSecrets } from './redact.js'

const SECRET = 'sk_live_9f8a7b6c5d4e3f2a1b0c'

describe('redactSecrets', () => {
  it('replaces the secret wherever it appears', () => {
    const out = redactSecrets(`Invalid key ${SECRET}; got ${SECRET} again`, [SECRET])
    expect(out).toBe('Invalid key [REDACTED]; got [REDACTED] again')
  })

  it('also catches the URL-encoded and base64 forms', () => {
    const tricky = 'p@ss word/+='
    const text = [
      `?api_key=${encodeURIComponent(tricky)}`,
      `Authorization: Basic ${Buffer.from(tricky).toString('base64')}`,
      `raw ${tricky}`,
    ].join('\n')

    const out = redactSecrets(text, [tricky])

    expect(out).not.toContain(encodeURIComponent(tricky))
    expect(out).not.toContain(Buffer.from(tricky).toString('base64'))
    expect(out).not.toContain(tricky)
    expect(out.match(/\[REDACTED\]/g)).toHaveLength(3)
  })

  it('handles several secrets, longest first', () => {
    const out = redactSecrets('a=abcd1234 b=abcd1234-extended', ['abcd1234', 'abcd1234-extended'])
    expect(out).toBe('a=[REDACTED] b=[REDACTED]')
  })

  it('leaves text alone when there is nothing to hide', () => {
    expect(redactSecrets('hello world', [])).toBe('hello world')
    expect(redactSecrets('hello world', [SECRET])).toBe('hello world')
  })

  it('ignores secrets too short to be real, so ordinary text is not mangled', () => {
    expect(redactSecrets('a b c 1 2 3', ['a', '1'])).toBe('a b c 1 2 3')
  })

  it('does not treat the secret as a pattern', () => {
    expect(redactSecrets('cost is $5.00 (est.)', ['$5.00 (est.)'])).toBe('cost is [REDACTED]')
    expect(redactSecrets('anything', ['.*.*.*.*'])).toBe('anything')
  })
})
