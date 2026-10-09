// A real key is "mcpg_" plus 32 base64url characters. The bounds are loose on purpose (they
// only keep obvious garbage, like a 10 MB header, away from the database), and the hash
// lookup is what actually decides.
const KEY_FORMAT = /^mcpg_[A-Za-z0-9_-]{16,128}$/

/** The API key from an `Authorization: Bearer <key>` header, or null if absent or malformed. */
export function parseBearerKey(header: string | undefined): string | null {
  if (!header) return null
  const match = /^Bearer ([^\s]+)$/i.exec(header)
  const token = match?.[1]
  return token && KEY_FORMAT.test(token) ? token : null
}
