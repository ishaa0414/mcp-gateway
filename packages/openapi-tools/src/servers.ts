export type BaseUrlResult =
  | { status: 'resolved'; url: string }
  /** The spec declares no servers. */
  | { status: 'none' }
  /** servers[0].url is relative and there is no spec URL to resolve it against (file upload). */
  | { status: 'relative'; raw: string }
  | { status: 'invalid'; raw: string; reason: string }

/**
 * Work out an absolute http(s) base URL from `servers[0]` of an OpenAPI document.
 *
 * - `{variable}` placeholders are replaced with the variable's declared default.
 * - A relative URL (e.g. "/api/v3") is resolved against `specUrl` when the spec
 *   was fetched from a URL, and reported as `relative` when it was uploaded.
 * - Anything that is not http(s), or that carries credentials, is `invalid`.
 *
 * The result is only syntactically valid; callers must still SSRF-check the host.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function resolveBaseUrl(doc: Record<string, any>, specUrl?: string): BaseUrlResult {
  const server = (doc['servers'] as Array<Record<string, unknown>> | undefined)?.[0]
  const rawUrl = server?.['url']
  if (typeof rawUrl !== 'string' || rawUrl.trim() === '') return { status: 'none' }

  const variables = (server?.['variables'] ?? {}) as Record<string, { default?: unknown }>
  let missing: string | undefined
  const substituted = rawUrl.trim().replace(/\{([^}]+)\}/g, (_m, name: string) => {
    const def = variables[name]?.default
    if (typeof def !== 'string' && typeof def !== 'number') {
      missing ??= name
      return ''
    }
    return String(def)
  })
  if (missing) {
    return { status: 'invalid', raw: rawUrl, reason: `server variable "${missing}" has no default value` }
  }

  const isAbsolute = /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(substituted)
  if (!isAbsolute && !specUrl) return { status: 'relative', raw: substituted }

  let parsed: URL
  try {
    parsed = isAbsolute ? new URL(substituted) : new URL(substituted, specUrl)
  } catch {
    return { status: 'invalid', raw: rawUrl, reason: 'not a valid URL' }
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { status: 'invalid', raw: rawUrl, reason: `unsupported protocol ${parsed.protocol}` }
  }
  if (parsed.username || parsed.password) {
    return { status: 'invalid', raw: rawUrl, reason: 'must not contain credentials' }
  }

  return { status: 'resolved', url: `${parsed.origin}${parsed.pathname.replace(/\/+$/, '')}` }
}
