import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

/**
 * The signature on a dashboard-to-gateway playground request. The dashboard signs, the gateway
 * verifies, and both use this file, so the two cannot drift apart.
 *
 * Signed string: `<timestamp>.<nonce>.<slug>.<tool>.<sha256(body)>`, HMAC-SHA256 with the shared
 * secret. The timestamp bounds how long a captured request is useful, the nonce makes two identical
 * runs differ (the gateway refuses a nonce it has seen), and the slug and tool tie the signature to
 * the project and tool it was made for.
 */

/** A request is accepted when its timestamp is within this distance of the verifier's clock, either way. */
export const PLAYGROUND_WINDOW_MS = 60_000
export const PLAYGROUND_NONCE_BYTES = 16
export const PLAYGROUND_MIN_SECRET_BYTES = 32

export const PLAYGROUND_HEADERS = {
  timestamp: 'x-playground-timestamp',
  nonce: 'x-playground-nonce',
  signature: 'x-playground-signature',
} as const

export interface PlaygroundRequestParts {
  /** Milliseconds since the epoch, as the signer's clock read. */
  timestamp: number
  /** Lower-case hex, at least 16 bytes (32 characters). */
  nonce: string
  slug: string
  tool: string
  /** The exact request body text. */
  body: string
}

export const newPlaygroundNonce = (): string => randomBytes(PLAYGROUND_NONCE_BYTES).toString('hex')

const NONCE_PATTERN = new RegExp(`^[0-9a-f]{${PLAYGROUND_NONCE_BYTES * 2},128}$`)

function signedString(r: PlaygroundRequestParts): string {
  return `${r.timestamp}.${r.nonce}.${r.slug}.${r.tool}.${createHash('sha256').update(r.body).digest('hex')}`
}

/** The signature (hex) to send in `x-playground-signature`. */
export function signPlaygroundRequest(secret: string, parts: PlaygroundRequestParts): string {
  return createHmac('sha256', secret).update(signedString(parts)).digest('hex')
}

export type PlaygroundVerdict = 'ok' | 'malformed' | 'expired' | 'bad_signature'

/** Check a request's signature. The comparison takes the same time wherever the first difference is. */
export function verifyPlaygroundRequest(
  secret: string,
  parts: PlaygroundRequestParts,
  signature: string,
  now: number = Date.now()
): PlaygroundVerdict {
  if (!Number.isSafeInteger(parts.timestamp) || !NONCE_PATTERN.test(parts.nonce) || !/^[0-9a-f]{64}$/.test(signature)) return 'malformed'
  if (Math.abs(now - parts.timestamp) > PLAYGROUND_WINDOW_MS) return 'expired'
  const expected = Buffer.from(signPlaygroundRequest(secret, parts), 'hex')
  return timingSafeEqual(expected, Buffer.from(signature, 'hex')) ? 'ok' : 'bad_signature'
}
