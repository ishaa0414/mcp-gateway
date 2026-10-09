import 'server-only'

/** The AES-256-GCM key for upstream credentials. The gateway uses the same variable to decrypt. */
export function encryptionKey(): string {
  const key = process.env['ENCRYPTION_KEY']
  if (!key || !/^[0-9a-f]{64}$/i.test(key)) {
    throw new Error('ENCRYPTION_KEY is missing or is not 64 hex characters')
  }
  return key
}
