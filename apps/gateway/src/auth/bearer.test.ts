import { generateApiKey } from '@mcp-gateway/crypto'
import { describe, expect, it } from 'vitest'
import { parseBearerKey } from './bearer.js'

describe('parseBearerKey', () => {
  it('accepts a freshly generated key', () => {
    const { key } = generateApiKey()
    expect(parseBearerKey(`Bearer ${key}`)).toBe(key)
  })

  it('is case-insensitive about the scheme', () => {
    const { key } = generateApiKey()
    expect(parseBearerKey(`bearer ${key}`)).toBe(key)
    expect(parseBearerKey(`BEARER ${key}`)).toBe(key)
  })

  it.each([
    ['missing header', undefined],
    ['empty header', ''],
    ['scheme only', 'Bearer'],
    ['scheme and space only', 'Bearer '],
    ['other scheme', 'Basic dXNlcjpwYXNz'],
    ['no scheme', 'mcpg_abcdefghijklmnopqrstuvwxyz012345'],
    ['wrong prefix', 'Bearer sk_abcdefghijklmnopqrstuvwxyz012345'],
    ['too short', 'Bearer mcpg_short'],
    ['too long', `Bearer mcpg_${'a'.repeat(500)}`],
    ['illegal characters', 'Bearer mcpg_abcdefghijklmnopqrstuvwxyz!@#$%^'],
    ['two tokens', 'Bearer mcpg_abcdefghijklmnopqrstuvwxyz012345 extra'],
    ['extra whitespace', 'Bearer  mcpg_abcdefghijklmnopqrstuvwxyz012345'],
  ])('rejects %s', (_label, header) => {
    expect(parseBearerKey(header)).toBeNull()
  })
})
