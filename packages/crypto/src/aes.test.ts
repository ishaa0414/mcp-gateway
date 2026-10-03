import { describe, it, expect } from 'vitest'
import { randomBytes } from 'node:crypto'
import { encrypt, decrypt } from './aes.js'

const validKey = () => randomBytes(32).toString('hex')

describe('AES-256-GCM encrypt/decrypt', () => {
  it('round-trips a short string', () => {
    const key = validKey()
    const plain = 'hello world'
    expect(decrypt(encrypt(plain, key), key)).toBe(plain)
  })

  it('round-trips an empty string', () => {
    const key = validKey()
    expect(decrypt(encrypt('', key), key)).toBe('')
  })

  it('round-trips a long string', () => {
    const key = validKey()
    const plain = 'x'.repeat(10_000)
    expect(decrypt(encrypt(plain, key), key)).toBe(plain)
  })

  it('round-trips unicode', () => {
    const key = validKey()
    const plain = '日本語テスト 🔐'
    expect(decrypt(encrypt(plain, key), key)).toBe(plain)
  })

  it('produces different ciphertexts on repeated calls (random IV)', () => {
    const key = validKey()
    const plain = 'same input'
    expect(encrypt(plain, key)).not.toBe(encrypt(plain, key))
  })

  it('ciphertext format is iv:tag:data', () => {
    const key = validKey()
    const ct = encrypt('test', key)
    const parts = ct.split(':')
    expect(parts).toHaveLength(3)
    expect(parts[0]).toHaveLength(24) // 12 bytes → 24 hex chars
    expect(parts[1]).toHaveLength(32) // 16 bytes → 32 hex chars
  })

  it('throws on wrong key length', () => {
    expect(() => encrypt('x', 'tooshort')).toThrow('ENCRYPTION_KEY must be 32 bytes')
    expect(() => decrypt('a:b:c', 'tooshort')).toThrow('ENCRYPTION_KEY must be 32 bytes')
  })

  it('throws on tampered ciphertext (auth tag mismatch)', () => {
    const key = validKey()
    const ct = encrypt('secret', key)
    const parts = ct.split(':')
    const tampered = [parts[0], parts[1], 'deadbeef' + parts[2]!.slice(8)].join(':')
    expect(() => decrypt(tampered, key)).toThrow()
  })

  it('throws on malformed ciphertext', () => {
    const key = validKey()
    expect(() => decrypt('notvalidformat', key)).toThrow('Invalid ciphertext format')
  })

  it('throws when decrypting with a different key', () => {
    const key1 = validKey()
    const key2 = validKey()
    const ct = encrypt('secret', key1)
    expect(() => decrypt(ct, key2)).toThrow()
  })
})
