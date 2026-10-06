import { assertPublicHttpUrl } from '@mcp-gateway/shared'

export type UpstreamUrlResult = { ok: true; url: string } | { ok: false; error: string }

/**
 * Validate an upstream base URL before it is stored. An empty string means
 * "not set yet" and is allowed. Anything else must be an absolute http(s) URL
 * whose host resolves to a public address. The result is normalised (no query,
 * fragment or trailing slash) so it can be joined with spec paths.
 */
export async function validateUpstreamUrl(raw: string): Promise<UpstreamUrlResult> {
  const trimmed = raw.trim()
  if (trimmed === '') return { ok: true, url: '' }

  try {
    const url = await assertPublicHttpUrl(trimmed)
    return { ok: true, url: `${url.origin}${url.pathname.replace(/\/+$/, '')}` }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Invalid URL' }
  }
}

/** True for a stored value that is a usable absolute base URL. */
export function isAbsoluteHttpUrl(value: string): boolean {
  return /^https?:\/\/[^/]/i.test(value)
}
