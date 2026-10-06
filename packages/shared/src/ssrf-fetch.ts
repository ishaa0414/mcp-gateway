import { request as undiciRequest, Client } from 'undici'
import { lookup as dnsLookup } from 'node:dns/promises'
import { isIPv4 } from 'node:net'

const MAX_REDIRECTS = 3
const TIMEOUT_MS = 10_000
const MAX_BYTES = 5 * 1024 * 1024 // 5 MB

export class SsrfError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SsrfError'
  }
}

// IPv4 private/reserved CIDR ranges
const BLOCKED_V4: Array<{ prefix: number; mask: number }> = [
  { prefix: 0x00000000, mask: 0xff000000 }, // 0.0.0.0/8
  { prefix: 0x0a000000, mask: 0xff000000 }, // 10.0.0.0/8
  { prefix: 0x64400000, mask: 0xffc00000 }, // 100.64.0.0/10 CGNAT
  { prefix: 0x7f000000, mask: 0xff000000 }, // 127.0.0.0/8 loopback
  { prefix: 0xa9fe0000, mask: 0xffff0000 }, // 169.254.0.0/16 link-local / metadata
  { prefix: 0xac100000, mask: 0xfff00000 }, // 172.16.0.0/12
  { prefix: 0xc0a80000, mask: 0xffff0000 }, // 192.168.0.0/16
]

function ipv4ToInt(ip: string): number {
  return ip.split('.').reduce((acc, octet) => (acc << 8) | parseInt(octet, 10), 0) >>> 0
}

export function isBlockedIpv4(ip: string): boolean {
  const n = ipv4ToInt(ip)
  // >>> 0 normalises the signed 32-bit AND result back to unsigned for comparison
  return BLOCKED_V4.some(({ prefix, mask }) => ((n & mask) >>> 0) === prefix)
}

export function isBlockedIpv6(ip: string): boolean {
  // Strip zone ID
  const addr = ip.split('%')[0]?.toLowerCase() ?? ''

  if (addr === '::' || addr === '::0' || addr === '0:0:0:0:0:0:0:0') return true
  if (addr === '::1' || addr === '0:0:0:0:0:0:0:1') return true // loopback

  // IPv4-mapped: ::ffff:x.x.x.x or ::ffff:hhhh:hhhh
  if (addr.startsWith('::ffff:')) {
    const rest = addr.slice(7)
    if (isIPv4(rest)) return isBlockedIpv4(rest)
    // hex form e.g. 7f00:1 → 127.0.0.1
    const hexParts = rest.split(':')
    const p0 = hexParts[0]
    const p1 = hexParts[1]
    if (hexParts.length === 2 && p0 !== undefined && p1 !== undefined) {
      const hi = parseInt(p0, 16)
      const lo = parseInt(p1, 16)
      const mapped = `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`
      return isBlockedIpv4(mapped)
    }
    return true // unknown format — block
  }

  // Expand the first group to check fc00::/7 and fe80::/10
  const firstGroup = parseInt(addr.split(':')[0] ?? '0', 16)
  if ((firstGroup & 0xfe00) === 0xfc00) return true // fc00::/7 ULA
  if ((firstGroup & 0xffc0) === 0xfe80) return true // fe80::/10 link-local

  return false
}

function isPrivateIp(ip: string): boolean {
  return isIPv4(ip) ? isBlockedIpv4(ip) : isBlockedIpv6(ip)
}

function allowPrivate(): boolean {
  return process.env['NODE_ENV'] === 'development' && process.env['ALLOW_PRIVATE_UPSTREAMS'] === 'true'
}

async function resolveAndValidate(hostname: string): Promise<{ ip: string; family: 4 | 6 }> {
  // Bracketed IPv6 address
  const bareV6 =
    hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : null

  if (bareV6) {
    if (isPrivateIp(bareV6) && !allowPrivate())
      throw new SsrfError(`Blocked IPv6 address: ${bareV6}`)
    return { ip: bareV6, family: 6 }
  }

  if (isIPv4(hostname)) {
    if (isPrivateIp(hostname) && !allowPrivate())
      throw new SsrfError(`Blocked IP address: ${hostname}`)
    return { ip: hostname, family: 4 }
  }

  const { address, family } = await dnsLookup(hostname, { family: 0 })
  if (isPrivateIp(address) && !allowPrivate()) {
    throw new SsrfError(`Hostname ${hostname} resolved to blocked IP: ${address}`)
  }
  return { ip: address, family: family as 4 | 6 }
}

/**
 * Check, without fetching, that a URL is absolute http(s), carries no
 * credentials, and that its host resolves only to public addresses. Used when an
 * upstream base URL is saved so a bad one is rejected up front rather than at call
 * time. Uses the same resolver and blocklist as ssrfFetch.
 */
export async function assertPublicHttpUrl(rawUrl: string): Promise<URL> {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    throw new SsrfError('Must be an absolute URL such as https://api.example.com')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new SsrfError(`Unsupported protocol ${url.protocol} (use http or https)`)
  }
  if (url.username || url.password) {
    throw new SsrfError('URL must not contain a username or password')
  }

  try {
    await resolveAndValidate(url.hostname)
  } catch (err) {
    if (err instanceof SsrfError) throw err
    throw new SsrfError(`Could not resolve host ${url.hostname}`)
  }
  return url
}

export interface SsrfFetchOptions {
  method?: string
  headers?: Record<string, string>
  signal?: AbortSignal
  maxBytes?: number
}

export interface SsrfResponse {
  status: number
  headers: Record<string, string>
  body: Buffer
  text(): string
  json(): unknown
}

export async function ssrfFetch(rawUrl: string, options: SsrfFetchOptions = {}): Promise<SsrfResponse> {
  const { method = 'GET', headers: extraHeaders = {}, signal, maxBytes = MAX_BYTES } = options

  const first = new URL(rawUrl)
  if (first.protocol !== 'http:' && first.protocol !== 'https:') {
    throw new SsrfError(`Unsupported protocol: ${first.protocol}`)
  }

  let currentUrl = rawUrl

  for (let hops = 0; ; hops++) {
    if (hops > MAX_REDIRECTS) throw new SsrfError(`Too many redirects (max ${MAX_REDIRECTS})`)

    const parsed = new URL(currentUrl)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new SsrfError(`Redirect to unsupported protocol: ${parsed.protocol}`)
    }

    const { ip, family } = await resolveAndValidate(parsed.hostname)
    const isHttps = parsed.protocol === 'https:'
    const defaultPort = isHttps ? 443 : 80
    const port = parsed.port ? parseInt(parsed.port, 10) : defaultPort

    const ipHost = family === 6 ? `[${ip}]` : ip
    const origin = `${parsed.protocol}//${ipHost}:${port}`
    const reqPath = parsed.pathname + parsed.search

    const reqHeaders: Record<string, string> = {
      host: parsed.port ? `${parsed.hostname}:${parsed.port}` : parsed.hostname,
      ...extraHeaders,
    }

    // For HTTPS, create a one-off Client with SNI set to the original hostname
    // so the TLS handshake uses the correct name even though we connect to the IP.
    let responseData
    if (isHttps) {
      const client = new Client(origin, {
        connect: { servername: parsed.hostname },
      })
      try {
        responseData = await client.request({
          path: reqPath,
          method,
          headers: reqHeaders,
          headersTimeout: TIMEOUT_MS,
          bodyTimeout: TIMEOUT_MS,
          signal: signal ?? null,
        })
      } finally {
        await client.close()
      }
    } else {
      responseData = await undiciRequest(origin + reqPath, {
        method,
        headers: reqHeaders,
        headersTimeout: TIMEOUT_MS,
        bodyTimeout: TIMEOUT_MS,
        signal: signal ?? null,
      })
    }

    const { statusCode, headers: respHeaders, body } = responseData

    if (statusCode >= 300 && statusCode < 400) {
      // Consume body to free the connection
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      for await (const _chunk of body) { /* drain */ }

      const loc = Array.isArray(respHeaders['location'])
        ? respHeaders['location'][0]
        : respHeaders['location']
      if (!loc) throw new SsrfError('Redirect with no Location header')
      currentUrl = new URL(loc, currentUrl).toString()
      continue
    }

    // Read body with size cap
    const chunks: Buffer[] = []
    let totalBytes = 0
    for await (const chunk of body) {
      totalBytes += chunk.length
      if (totalBytes > maxBytes) {
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        for await (const _chunk of body) { /* drain */ }
        throw new SsrfError(`Response too large (max ${maxBytes} bytes)`)
      }
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
    }

    const buf = Buffer.concat(chunks)

    const normalized: Record<string, string> = {}
    for (const [k, v] of Object.entries(respHeaders)) {
      if (v !== undefined) normalized[k] = Array.isArray(v) ? v.join(', ') : (v as string)
    }

    return {
      status: statusCode,
      headers: normalized,
      body: buf,
      text() { return buf.toString('utf-8') },
      json() { return JSON.parse(buf.toString('utf-8')) },
    }
  }
}
