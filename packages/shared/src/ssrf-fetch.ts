import { request as undiciRequest, Client } from 'undici'
import { lookup as dnsLookup } from 'node:dns/promises'
import { isIPv4 } from 'node:net'

const MAX_REDIRECTS = 3
const DEFAULT_TIMEOUT_MS = 15_000
const MAX_BYTES = 5 * 1024 * 1024 // 5 MB

export type SsrfErrorCode = 'BLOCKED' | 'INVALID_REQUEST' | 'TIMEOUT' | 'TOO_LARGE' | 'REDIRECT'

export class SsrfError extends Error {
  constructor(
    message: string,
    readonly code: SsrfErrorCode = 'BLOCKED'
  ) {
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
  { prefix: 0xc6120000, mask: 0xfffe0000 }, // 198.18.0.0/15 benchmarking
  { prefix: 0xe0000000, mask: 0xf0000000 }, // 224.0.0.0/4 multicast
  { prefix: 0xf0000000, mask: 0xf0000000 }, // 240.0.0.0/4 reserved, incl. 255.255.255.255
]

function ipv4ToInt(ip: string): number {
  return ip.split('.').reduce((acc, octet) => (acc << 8) | parseInt(octet, 10), 0) >>> 0
}

export function isBlockedIpv4(ip: string): boolean {
  const n = ipv4ToInt(ip)
  // >>> 0 normalises the signed 32-bit AND result back to unsigned for comparison
  return BLOCKED_V4.some(({ prefix, mask }) => ((n & mask) >>> 0) === prefix)
}

/** Expand an IPv6 literal to its eight 16-bit groups, or null when it is malformed. */
function ipv6Groups(ip: string): number[] | null {
  let addr = (ip.split('%')[0] ?? '').toLowerCase()

  // An embedded IPv4 tail (::ffff:1.2.3.4) stands for the last two groups.
  const v4 = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(addr)
  if (v4) {
    const [a, b, c, d] = v4.slice(1).map(Number) as [number, number, number, number]
    if ([a, b, c, d].some((n) => n > 255)) return null
    addr = `${addr.slice(0, v4.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`
  }

  const halves = addr.split('::')
  if (halves.length > 2) return null
  const head = halves[0] ? halves[0].split(':') : []
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : []

  let parts: string[]
  if (halves.length === 1) {
    if (head.length !== 8) return null
    parts = head
  } else {
    const fill = 8 - head.length - tail.length
    if (fill < 1) return null
    parts = [...head, ...Array<string>(fill).fill('0'), ...tail]
  }
  if (!parts.every((p) => /^[0-9a-f]{1,4}$/.test(p))) return null
  return parts.map((p) => parseInt(p, 16))
}

export function isBlockedIpv6(ip: string): boolean {
  const g = ipv6Groups(ip)
  if (!g) return true // unparseable: fail closed

  const zero = (from: number, to: number) => g.slice(from, to).every((x) => x === 0)

  if (zero(0, 6)) return true // ::, ::1 and the deprecated IPv4-compatible ::a.b.c.d
  if (zero(0, 5) && g[5] === 0xffff) {
    // IPv4-mapped (::ffff:a.b.c.d, in any spelling): judge the embedded address
    const hi = g[6]!
    const lo = g[7]!
    return isBlockedIpv4(`${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`)
  }
  if (g[0] === 0x64 && g[1] === 0xff9b && zero(2, 6)) return true // 64:ff9b::/96 NAT64
  if ((g[0]! & 0xfe00) === 0xfc00) return true // fc00::/7 ULA
  if ((g[0]! & 0xffc0) === 0xfe80) return true // fe80::/10 link-local

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
  /**
   * Request body, for POST, PUT and PATCH only. A string or Buffer is sent as-is
   * (set your own Content-Type); anything else is sent as JSON with
   * `Content-Type: application/json` unless you set one.
   */
  body?: unknown
  signal?: AbortSignal
  maxBytes?: number
  /** One deadline for the whole call: DNS, connect, redirects and reading the body. Default 15 s. */
  timeoutMs?: number
  /** Follow redirects (default true). When false, a 3xx response is returned as-is. */
  followRedirects?: boolean
}

export interface SsrfResponse {
  status: number
  headers: Record<string, string>
  body: Buffer
  text(): string
  json(): unknown
}

const BODY_METHODS = new Set(['POST', 'PUT', 'PATCH'])

// Controlled by this helper, never by the caller.
const FORBIDDEN_HEADERS = new Set([
  'host',
  'content-length',
  'transfer-encoding',
  'connection',
  'keep-alive',
  'proxy-connection',
  'te',
  'trailer',
  'upgrade',
])

// The only caller headers that may follow a redirect to a different origin.
// Everything else (Authorization, API-key headers, cookies, …) is dropped.
const CROSS_ORIGIN_HEADERS = new Set(['accept', 'accept-language', 'content-type', 'user-agent'])

function normalizeHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase()
    if (!FORBIDDEN_HEADERS.has(lower)) out[lower] = value
  }
  return out
}

function encodeBody(body: unknown): { payload: string | Buffer; isJson: boolean } {
  if (typeof body === 'string' || Buffer.isBuffer(body)) return { payload: body, isJson: false }
  if (body instanceof Uint8Array) return { payload: Buffer.from(body), isJson: false }
  let json: string | undefined
  try {
    json = JSON.stringify(body)
  } catch {
    json = undefined
  }
  if (json === undefined) throw new SsrfError('Request body is not JSON-serialisable', 'INVALID_REQUEST')
  return { payload: json, isJson: true }
}

/** Reject as soon as `signal` aborts, even if `promise` (e.g. a DNS lookup) cannot be cancelled. */
function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason)
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason)
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort))
  })
}

/**
 * Abandon a response body. Destroying an undici body emits an 'error' event; with
 * no listener Node treats that as an uncaught exception and kills the process, so
 * a listener is attached first.
 */
function discard(body: unknown): void {
  const stream = body as { on?: (event: string, fn: () => void) => unknown; destroy?: () => void } | null
  stream?.on?.('error', () => undefined)
  stream?.destroy?.()
}

export async function ssrfFetch(rawUrl: string, options: SsrfFetchOptions = {}): Promise<SsrfResponse> {
  const {
    headers: extraHeaders = {},
    signal,
    maxBytes = MAX_BYTES,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    followRedirects = true,
  } = options
  let method = (options.method ?? 'GET').toUpperCase()

  if (options.body !== undefined && !BODY_METHODS.has(method)) {
    throw new SsrfError(`A request body is only supported for POST, PUT and PATCH, not ${method}`, 'INVALID_REQUEST')
  }

  const first = new URL(rawUrl)
  if (first.protocol !== 'http:' && first.protocol !== 'https:') {
    throw new SsrfError(`Unsupported protocol: ${first.protocol}`)
  }

  let headers = normalizeHeaders(extraHeaders)
  let payload: string | Buffer | undefined
  if (options.body !== undefined) {
    const encoded = encodeBody(options.body)
    payload = encoded.payload
    if (encoded.isJson && !('content-type' in headers)) headers['content-type'] = 'application/json'
  }

  const deadline = AbortSignal.timeout(timeoutMs)
  const combined = signal ? AbortSignal.any([signal, deadline]) : deadline

  try {
    let currentUrl = rawUrl

    for (let hops = 0; ; hops++) {
      if (hops > MAX_REDIRECTS) throw new SsrfError(`Too many redirects (max ${MAX_REDIRECTS})`, 'REDIRECT')

      const parsed = new URL(currentUrl)
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new SsrfError(`Redirect to unsupported protocol: ${parsed.protocol}`, 'REDIRECT')
      }

      const { ip, family } = await abortable(resolveAndValidate(parsed.hostname), combined)
      const isHttps = parsed.protocol === 'https:'
      const defaultPort = isHttps ? 443 : 80
      const port = parsed.port ? parseInt(parsed.port, 10) : defaultPort

      const ipHost = family === 6 ? `[${ip}]` : ip
      const origin = `${parsed.protocol}//${ipHost}:${port}`
      const reqPath = parsed.pathname + parsed.search

      const reqHeaders: Record<string, string> = {
        ...headers,
        host: parsed.port ? `${parsed.hostname}:${parsed.port}` : parsed.hostname,
      }
      const requestOptions = {
        method,
        headers: reqHeaders,
        ...(payload !== undefined ? { body: payload } : {}),
        headersTimeout: timeoutMs,
        bodyTimeout: timeoutMs,
        signal: combined,
      }

      // For HTTPS, use a one-off Client with SNI set to the original hostname so the
      // TLS handshake uses the correct name even though we connect to the validated IP.
      // It is closed only after the body has been read: closing first waits for the
      // request to finish, which cannot happen while nobody is consuming the body.
      const client = isHttps ? new Client(origin, { connect: { servername: parsed.hostname } }) : null
      try {
        const responseData = client
          ? await client.request({ path: reqPath, ...requestOptions })
          : await undiciRequest(origin + reqPath, requestOptions)
        const { statusCode, headers: respHeaders, body } = responseData

        if (followRedirects && statusCode >= 300 && statusCode < 400) {
          discard(body)

          const loc = Array.isArray(respHeaders['location']) ? respHeaders['location'][0] : respHeaders['location']
          if (!loc) throw new SsrfError('Redirect with no Location header', 'REDIRECT')
          const next = new URL(loc, currentUrl)

          // 301/302/303 turn a POST into a GET without a body (as browsers do);
          // 307/308 keep the method and body.
          if (statusCode === 303 || ((statusCode === 301 || statusCode === 302) && method === 'POST')) {
            if (method !== 'HEAD') method = 'GET'
            payload = undefined
            delete headers['content-type']
          }

          if (next.origin !== parsed.origin) {
            if (payload !== undefined) {
              throw new SsrfError('Refusing to forward a request body to a different origin', 'REDIRECT')
            }
            // Credentials must not follow a redirect to another origin.
            headers = Object.fromEntries(Object.entries(headers).filter(([k]) => CROSS_ORIGIN_HEADERS.has(k)))
          }

          currentUrl = next.toString()
          continue
        }

        const declared = Number(respHeaders['content-length'])
        if (Number.isFinite(declared) && declared > maxBytes) {
          discard(body)
          throw new SsrfError(`Response too large (max ${maxBytes} bytes)`, 'TOO_LARGE')
        }

        const chunks: Buffer[] = []
        let totalBytes = 0
        for await (const chunk of body) {
          totalBytes += chunk.length
          if (totalBytes > maxBytes) {
            discard(body)
            throw new SsrfError(`Response too large (max ${maxBytes} bytes)`, 'TOO_LARGE')
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
      } finally {
        if (client) await client.close().catch(() => undefined)
      }
    }
  } catch (err) {
    if (err instanceof SsrfError) throw err
    if (deadline.aborted && !signal?.aborted) {
      throw new SsrfError(`Request timed out after ${timeoutMs} ms`, 'TIMEOUT')
    }
    throw err
  }
}
