import { describe, expect, it } from 'vitest'
import {
  newPlaygroundNonce,
  PLAYGROUND_WINDOW_MS,
  signPlaygroundRequest,
  verifyPlaygroundRequest,
  type PlaygroundRequestParts,
} from './playground-signature.js'

const SECRET = 'a'.repeat(32)
const NOW = 1_800_000_000_000
const parts = (over: Partial<PlaygroundRequestParts> = {}): PlaygroundRequestParts => ({
  timestamp: NOW,
  nonce: 'ab'.repeat(16),
  slug: 'shop',
  tool: 'getPet',
  body: '{"tool":"getPet","arguments":{"petId":1}}',
  ...over,
})
const verify = (p: PlaygroundRequestParts, sig = signPlaygroundRequest(SECRET, p), now = NOW, secret = SECRET) =>
  verifyPlaygroundRequest(secret, p, sig, now)

describe('playground signature', () => {
  it('a request verifies with the secret it was signed with', () => {
    expect(verify(parts())).toBe('ok')
  })

  it('is deterministic, and different for each signed part', () => {
    const base = signPlaygroundRequest(SECRET, parts())
    expect(signPlaygroundRequest(SECRET, parts())).toBe(base)
    for (const change of [{ timestamp: NOW + 1 }, { nonce: 'cd'.repeat(16) }, { slug: 'other' }, { tool: 'createPet' }, { body: '{}' }]) {
      expect(signPlaygroundRequest(SECRET, parts(change))).not.toBe(base)
    }
  })

  it('rejects a wrong secret and a tampered part', () => {
    const sig = signPlaygroundRequest(SECRET, parts())
    expect(verify(parts(), sig, NOW, 'b'.repeat(32))).toBe('bad_signature')
    for (const change of [{ slug: 'other' }, { tool: 'createPet' }, { body: '{"tool":"getPet","arguments":{"petId":2}}' }, { nonce: 'cd'.repeat(16) }]) {
      expect(verify(parts(change), sig)).toBe('bad_signature')
    }
  })

  it('accepts the edges of the window and rejects beyond it, in the past and the future', () => {
    const sign = (timestamp: number) => parts({ timestamp })
    expect(verify(sign(NOW - PLAYGROUND_WINDOW_MS))).toBe('ok')
    expect(verify(sign(NOW + PLAYGROUND_WINDOW_MS))).toBe('ok')
    expect(verify(sign(NOW - PLAYGROUND_WINDOW_MS - 1))).toBe('expired')
    expect(verify(sign(NOW + PLAYGROUND_WINDOW_MS + 1))).toBe('expired')
  })

  it('rejects malformed input without throwing: short nonce, non-hex nonce, bad signature text, bad timestamp', () => {
    expect(verify(parts({ nonce: 'ab'.repeat(15) }))).toBe('malformed') // 15 bytes
    expect(verify(parts({ nonce: 'zz'.repeat(16) }))).toBe('malformed')
    expect(verify(parts(), 'not-a-signature')).toBe('malformed')
    expect(verify(parts(), 'ab'.repeat(31))).toBe('malformed')
    expect(verify(parts({ timestamp: Number.NaN }))).toBe('malformed')
  })

  it('a fresh nonce is 16 random bytes of hex, never repeated', () => {
    const nonces = new Set(Array.from({ length: 200 }, newPlaygroundNonce))
    expect(nonces.size).toBe(200)
    for (const n of nonces) expect(n).toMatch(/^[0-9a-f]{32}$/)
  })
})
