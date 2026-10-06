import type { RequestMap } from './types.js'

/** The arguments cannot be turned into a valid request (missing path value, unsafe value, …). */
export class RequestBuildError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RequestBuildError'
  }
}

export interface BuildRequestInput {
  /** Absolute upstream base URL, e.g. https://api.example.com/v1 (no trailing slash needed). */
  baseUrl: string
  method: string
  /** The OpenAPI path template, e.g. /pet/{petId}. */
  path: string
  map: RequestMap
  /** Hidden-parameter values already merged in, keyed by argument name. */
  args: Record<string, unknown>
}

export interface BuiltRequest {
  method: string
  /** Absolute URL. Credentials are added by the caller, never here. */
  url: string
  /** Lower-case header names. */
  headers: Record<string, string>
  body?: string
}

const BODY_METHODS = new Set(['POST', 'PUT', 'PATCH'])

const isSet = (v: unknown): boolean => v !== undefined && v !== null

/** Scalars as text; arrays comma-joined; objects as JSON. */
function asText(value: unknown): string {
  if (Array.isArray(value)) return value.map(asText).join(',')
  if (typeof value === 'object' && value !== null) return JSON.stringify(value)
  return String(value)
}

function assertHeaderSafe(name: string, value: string): void {
  if (/[\r\n\0]/.test(value)) {
    throw new RequestBuildError(`Value for header "${name}" contains a line break or control character`)
  }
}

/** Turn a tool call's arguments into an HTTP request using the operation's request map. */
export function buildRequest(input: BuildRequestInput): BuiltRequest {
  const { map, args } = input
  const method = input.method.toUpperCase()

  // --- path ---
  const pathBindings = new Map(map.bindings.filter((b) => b.in === 'path').map((b) => [b.name, b]))
  const path = input.path.replace(/\{([^}]+)\}/g, (_match, placeholder: string) => {
    const binding = pathBindings.get(placeholder)
    const value = binding ? args[binding.arg] : undefined
    if (!binding || !isSet(value)) {
      throw new RequestBuildError(`Missing required path parameter "${binding?.arg ?? placeholder}"`)
    }
    const text = asText(value)
    if (text === '' || text === '.' || text === '..') {
      // "." and ".." would be resolved as dot-segments and escape the intended path.
      throw new RequestBuildError(`Path parameter "${binding.arg}" has an invalid value`)
    }
    return encodeURIComponent(text)
  })

  // --- query ---
  const query: string[] = []
  for (const b of map.bindings) {
    if (b.in !== 'query') continue
    const value = args[b.arg]
    if (!isSet(value)) continue
    const key = encodeURIComponent(b.name)
    if (Array.isArray(value) && b.explode !== false) {
      for (const item of value) if (isSet(item)) query.push(`${key}=${encodeURIComponent(asText(item))}`)
    } else {
      query.push(`${key}=${encodeURIComponent(asText(value))}`)
    }
  }

  // --- headers and cookies ---
  const headers: Record<string, string> = { accept: 'application/json, text/plain;q=0.9, */*;q=0.8' }
  for (const b of map.bindings) {
    if (b.in !== 'header' || !isSet(args[b.arg])) continue
    const value = asText(args[b.arg])
    assertHeaderSafe(b.name, value)
    headers[b.name.toLowerCase()] = value
  }
  const cookies = map.bindings
    .filter((b) => b.in === 'cookie' && isSet(args[b.arg]))
    .map((b) => `${encodeURIComponent(b.name)}=${encodeURIComponent(asText(args[b.arg]))}`)
  if (cookies.length) headers['cookie'] = cookies.join('; ')

  // --- body ---
  let body: string | undefined
  const root = map.bindings.find((b) => b.in === 'bodyRoot')
  if (root && isSet(args[root.arg])) {
    body = JSON.stringify(args[root.arg])
    headers['content-type'] = 'application/json'
  } else {
    const fields = map.bindings.filter((b) => b.in === 'body' && args[b.arg] !== undefined)
    if (fields.length > 0) {
      if (map.bodyContentType === 'form') {
        const form = new URLSearchParams()
        for (const b of fields) {
          const value = args[b.arg]
          if (Array.isArray(value)) for (const item of value) form.append(b.name, asText(item))
          else if (isSet(value)) form.append(b.name, asText(value))
        }
        body = form.toString()
        headers['content-type'] = 'application/x-www-form-urlencoded'
      } else {
        body = JSON.stringify(Object.fromEntries(fields.map((b) => [b.name, args[b.arg]])))
        headers['content-type'] = 'application/json'
      }
    }
  }

  if (body !== undefined && !BODY_METHODS.has(method)) {
    throw new RequestBuildError(`${method} requests cannot carry a request body`)
  }

  const base = input.baseUrl.replace(/\/+$/, '')
  const url = `${base}${path}${query.length ? `?${query.join('&')}` : ''}`
  try {
    new URL(url)
  } catch {
    throw new RequestBuildError('The upstream base URL and path do not form a valid URL')
  }

  return { method, url, headers, ...(body !== undefined ? { body } : {}) }
}
