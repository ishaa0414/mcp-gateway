/**
 * Scrub secrets from any text that leaves the gateway (tool results, errors, logs).
 *
 * Upstream error pages sometimes echo the request, including the credential we sent,
 * and a credential can appear encoded (URL-encoded in a query string, base64 inside a
 * Basic header). Every plausible form of each secret is replaced.
 */

const MASK = '[REDACTED]'
// Too short to be a secret and would mangle ordinary text ("a", "1").
const MIN_SECRET_LENGTH = 4

function variantsOf(secret: string): string[] {
  const variants = new Set<string>([secret, encodeURIComponent(secret), Buffer.from(secret).toString('base64')])
  // Basic auth style "user:secret" is base64 of a longer string, so also cover the unpadded form.
  variants.add(Buffer.from(secret).toString('base64').replace(/=+$/, ''))
  variants.add(Buffer.from(secret).toString('base64url'))
  return [...variants].filter((v) => v.length >= MIN_SECRET_LENGTH)
}

export function redactSecrets(text: string, secrets: readonly string[]): string {
  let out = text
  // Longest first so a secret that contains another is masked as a whole.
  const all = secrets
    .filter((s) => s.length >= MIN_SECRET_LENGTH)
    .flatMap(variantsOf)
    .sort((a, b) => b.length - a.length)
  for (const variant of all) out = out.split(variant).join(MASK)
  return out
}
