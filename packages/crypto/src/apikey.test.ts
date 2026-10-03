import { describe, it, expect } from 'vitest'
import { generateApiKey, hashApiKey } from './apikey.js'

describe('generateApiKey', () => {
  it('key starts with mcpg_ prefix', () => {
    const { key } = generateApiKey()
    expect(key).toMatch(/^mcpg_/)
  })

  it('prefix is a short displayable string ending with ellipsis', () => {
    const { prefix } = generateApiKey()
    expect(prefix).toMatch(/^mcpg_[A-Za-z0-9_-]{4}…$/)
  })

  it('hash is a 64-char hex string (SHA-256)', () => {
    const { hash } = generateApiKey()
    expect(hash).toMatch(/^[a-f0-9]{64}$/)
  })

  it('hash matches hashApiKey(key)', () => {
    const { key, hash } = generateApiKey()
    expect(hashApiKey(key)).toBe(hash)
  })

  it('generates unique keys each time', () => {
    const keys = Array.from({ length: 20 }, () => generateApiKey().key)
    expect(new Set(keys).size).toBe(20)
  })

  it('generates unique hashes each time', () => {
    const hashes = Array.from({ length: 20 }, () => generateApiKey().hash)
    expect(new Set(hashes).size).toBe(20)
  })
})

describe('hashApiKey', () => {
  it('is deterministic', () => {
    const key = 'mcpg_testkey123'
    expect(hashApiKey(key)).toBe(hashApiKey(key))
  })

  it('different keys produce different hashes', () => {
    expect(hashApiKey('mcpg_aaa')).not.toBe(hashApiKey('mcpg_bbb'))
  })

  it('returns lowercase hex', () => {
    expect(hashApiKey('any')).toMatch(/^[a-f0-9]{64}$/)
  })
})
