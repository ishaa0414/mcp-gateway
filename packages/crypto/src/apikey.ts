import { createHash, randomBytes } from 'node:crypto'

const KEY_PREFIX = 'mcpg_'
const RANDOM_BYTES = 24 // 32 base64url chars

export interface GeneratedApiKey {
  /** Full key shown to user once at creation. Never stored. */
  key: string
  /** Short visible prefix stored in DB for UI display, e.g. "mcpg_aB3x…" */
  prefix: string
  /** SHA-256 hash of the full key stored in DB for verification */
  hash: string
}

/** Generates a new API key, its display prefix, and its SHA-256 hash. */
export function generateApiKey(): GeneratedApiKey {
  const randomPart = randomBytes(RANDOM_BYTES).toString('base64url')
  const key = `${KEY_PREFIX}${randomPart}`
  // Prefix: "mcpg_" + first 4 random chars + "…"
  const prefix = `${KEY_PREFIX}${randomPart.slice(0, 4)}…`
  const hash = hashApiKey(key)
  return { key, prefix, hash }
}

/** Computes the SHA-256 hex digest of an API key. */
export function hashApiKey(key: string): string {
  return createHash('sha256').update(key, 'utf8').digest('hex')
}
