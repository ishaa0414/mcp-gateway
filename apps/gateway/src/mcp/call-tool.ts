import { STATUS_CODES } from 'node:http'
import { decrypt } from '@mcp-gateway/crypto'
import { buildRequest, RequestBuildError } from '@mcp-gateway/openapi-tools'
import type { BuiltRequest } from '@mcp-gateway/openapi-tools'
import { isSensitiveKey, MASK, sanitizeErrorMessage, ssrfFetch, SsrfError } from '@mcp-gateway/shared'
import type { LogErrorClass, SsrfResponse } from '@mcp-gateway/shared'
import type { CallToolResult } from '@modelcontextprotocol/server'
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/server/validators/ajv'
import type { CachedTool, ProjectConfig } from '../cache/project-config.js'
import type { AppConfig, Logger } from '../config.js'
import { redactSecrets } from './redact.js'

type Check = (input: unknown) => { valid: true; data: unknown } | { valid: false; errorMessage: string }

/** Compiled argument validators, one per tool version. Compiling costs milliseconds; checking costs microseconds. */
export class ValidatorCache {
  private readonly ajv = new AjvJsonSchemaValidator()
  private readonly compiled = new Map<string, Check>()

  constructor(private readonly max = 500) {}

  get(tool: CachedTool): Check {
    const key = `${tool.id}:${tool.version}`
    let check = this.compiled.get(key)
    if (!check) {
      check = this.ajv.getValidator(tool.agentSchema) as unknown as Check
      if (this.compiled.size >= this.max) this.compiled.delete(this.compiled.keys().next().value!)
      this.compiled.set(key, check)
    }
    return check
  }
}

export interface ToolOutcome {
  result: CallToolResult
  /** HTTP status of the upstream response, when one was received. */
  upstreamStatus?: number
  /** Set on every failure; what the call log records. */
  errorClass?: LogErrorClass
  /**
   * The failure as it may be stored: the first line of the fixed wording only, never the
   * upstream's own text, the request URL or a redirect target (see sanitizeErrorMessage).
   */
  errorMessage?: string
  /** Size of the upstream response body, when one was received. */
  responseBytes?: number
}

interface Deps {
  config: AppConfig
  log: Logger
  validators: ValidatorCache
}

const ERROR_EXCERPT_CHARS = 2000

const fail = (text: string, errorClass: LogErrorClass, upstream?: { status: number; bytes: number }): ToolOutcome => ({
  result: { isError: true, content: [{ type: 'text', text }] },
  errorClass,
  errorMessage: sanitizeErrorMessage(text),
  ...(upstream ? { upstreamStatus: upstream.status, responseBytes: upstream.bytes } : {}),
})

const ok = (text: string, upstreamStatus: number, bytes: number): ToolOutcome => ({
  result: { content: [{ type: 'text', text }] },
  upstreamStatus,
  responseBytes: bytes,
})

function isTextual(contentType: string | undefined, body: Buffer): boolean {
  if (contentType) {
    const ct = contentType.toLowerCase()
    return ct.startsWith('text/') || /(json|xml|yaml|javascript|x-www-form-urlencoded|csv|graphql)/.test(ct)
  }
  return !body.includes(0)
}

/** Append a query parameter, replacing any the agent may have supplied under the same name. */
export function withQueryParam(url: string, name: string, value: string): string {
  const [base, query = ''] = url.split('?', 2) as [string, string | undefined]
  const kept = (query ?? '')
    .split('&')
    .filter((pair) => pair !== '' && decodeURIComponent(pair.split('=')[0] ?? '') !== name)
  kept.push(`${encodeURIComponent(name)}=${encodeURIComponent(value)}`)
  return `${base}?${kept.join('&')}`
}

function describeSsrfError(err: SsrfError, config: AppConfig): string {
  switch (err.code) {
    case 'BLOCKED':
      return 'The upstream host is not allowed: the gateway only calls public internet addresses.'
    case 'TIMEOUT':
      return `The upstream API did not respond within ${Math.round(config.toolTimeoutMs / 1000)} seconds.`
    case 'TOO_LARGE':
      return `The upstream response is larger than the ${Math.round(config.toolMaxResponseBytes / 1024)} KB limit.`
    default:
      return 'The request to the upstream API could not be made.'
  }
}

function classOfSsrfError(err: SsrfError): LogErrorClass {
  switch (err.code) {
    case 'BLOCKED':
      return 'BLOCKED'
    case 'TIMEOUT':
      return 'TIMEOUT'
    case 'TOO_LARGE':
      return 'TOO_LARGE'
    case 'REDIRECT':
      return 'REDIRECT'
    case 'INVALID_REQUEST':
      return 'REQUEST_BUILD'
    default:
      return 'UNREACHABLE'
  }
}

function formatResponse(res: SsrfResponse, secrets: string[]): ToolOutcome {
  const status = res.status
  const contentType = res.headers['content-type']
  const textual = isTextual(contentType, res.body)

  const upstream = { status, bytes: res.body.length }

  if (status >= 300 && status < 400) {
    return fail(
      `The upstream API answered with a redirect (HTTP ${status}). The gateway does not follow redirects; check the upstream base URL.`,
      'REDIRECT',
      upstream
    )
  }

  if (status >= 400) {
    const label = `The upstream API returned HTTP ${status}${STATUS_CODES[status] ? ` ${STATUS_CODES[status]}` : ''}.`
    const errorClass = status >= 500 ? 'UPSTREAM_5XX' : 'UPSTREAM_4XX'
    if (res.body.length === 0 || !textual) return fail(label, errorClass, upstream)
    const body = redactSecrets(res.text(), secrets)
    const excerpt = body.length > ERROR_EXCERPT_CHARS ? `${body.slice(0, ERROR_EXCERPT_CHARS)}… [truncated]` : body
    return fail(`${label}\n${excerpt}`, errorClass, upstream)
  }

  if (res.body.length === 0) return ok(`OK (HTTP ${status}, empty response)`, status, 0)
  if (!textual) {
    return ok(`HTTP ${status}: the response is binary (${contentType ?? 'unknown type'}, ${res.body.length} bytes) and cannot be shown as text.`, status, res.body.length)
  }
  return ok(redactSecrets(res.text(), secrets), status, res.body.length)
}

// --- what the dashboard playground may see of a call -----------------------------------------

/** The request as it may be shown: no credential, no hidden-parameter value. */
export interface RequestPreview {
  method: string
  url: string
  headers: Record<string, string>
  body?: string
}

/** The upstream's answer as it may be shown. */
export interface ResponsePreview {
  status: number
  /** Only the headers in SHOWN_RESPONSE_HEADERS. */
  headers: Record<string, string>
  /** Text bodies only, secrets redacted, cut at DISPLAY_BODY_CHARS. */
  body?: string
  /** Size of the upstream body in bytes, before any cut. */
  bodyBytes: number
  /** The body is not text, so only its type (in `headers`) and size are shown. */
  binary: boolean
  truncated: boolean
}

export interface UpstreamCall {
  /** Exactly what an MCP client gets. */
  outcome: ToolOutcome
  /** Present when `preview` was asked for and the request could be built. */
  request?: RequestPreview
  /** Present when `preview` was asked for and the upstream answered. */
  response?: ResponsePreview
}

export const DISPLAY_BODY_CHARS = 100_000

/** Shown in place of a credential. */
const CREDENTIAL_PLACEHOLDER = '••••'
/** Shown in place of a hidden parameter's value. */
const HIDDEN_PLACEHOLDER = 'HIDDEN'

// Everything else (set-cookie, authorization echoes, server internals) is dropped.
const SHOWN_RESPONSE_HEADERS = new Set(['content-type', 'content-length', 'date', 'cache-control', 'etag', 'last-modified', 'retry-after'])
const isShownResponseHeader = (name: string) => SHOWN_RESPONSE_HEADERS.has(name) || name.startsWith('ratelimit-') || name.startsWith('x-ratelimit-')

/**
 * The hidden parameters as arguments. A hidden parameter fixed to `null` means "never send it": it
 * becomes `undefined`, which still overrides whatever the caller sent under that name, and the
 * request builder then leaves it out (as a query, header or body field alike).
 */
function hiddenArguments(hidden: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(hidden).map(([name, value]) => [name, value ?? undefined]))
}

/** Rewrite each `name=value` pair of a URL's query; return null from `fn` to drop a pair. */
function rewriteQuery(url: string, fn: (name: string, pair: string) => string | null): string {
  const at = url.indexOf('?')
  if (at === -1) return url
  const pairs = url
    .slice(at + 1)
    .split('&')
    .filter((p) => p !== '')
    .flatMap((pair) => {
      let name = pair.split('=')[0] ?? ''
      try {
        name = decodeURIComponent(name)
      } catch {
        // keep the raw name
      }
      const out = fn(name, pair)
      return out === null ? [] : [out]
    })
  return pairs.length ? `${url.slice(0, at)}?${pairs.join('&')}` : url.slice(0, at)
}

/** Replace the value of every sensitive key in parsed JSON, at any depth. */
function maskSensitiveJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(maskSensitiveJson)
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, isSensitiveKey(k) ? MASK : maskSensitiveJson(v)]))
  }
  return value
}

function previewBody(body: string, contentType: string | undefined): string {
  const type = (contentType ?? '').toLowerCase()
  try {
    if (type.includes('json')) return JSON.stringify(maskSensitiveJson(JSON.parse(body)))
    if (type.includes('x-www-form-urlencoded')) {
      const form = new URLSearchParams(body)
      for (const name of new Set(form.keys())) if (isSensitiveKey(name)) form.set(name, MASK)
      return form.toString()
    }
  } catch {
    // not parseable: fall through to the redaction pass, which still runs on the text
  }
  return body
}

/**
 * The request as the user may see it. Built before the credential is added, from a second build in
 * which every hidden parameter is `HIDDEN`, so no hidden value is ever in the text (a text replace
 * could not catch a short value). The credential is shown as a placeholder by kind. Sensitive header,
 * query and body names are masked like call logs, and `redactSecrets` runs last with the credential as a
 * second layer. A hidden value is not a secret and is not in that list: see `callUpstream`.
 */
function previewRequest(project: ProjectConfig, tool: CachedTool, args: Record<string, unknown>, built: BuiltRequest, secrets: readonly string[]): RequestPreview {
  let shown = built
  if (Object.keys(tool.hidden).length > 0) {
    try {
      // A hidden parameter fixed to null is not sent, so there is nothing to show for it.
      const placeholders = Object.fromEntries(Object.entries(tool.hidden).map(([name, value]) => [name, value === null || value === undefined ? undefined : HIDDEN_PLACEHOLDER]))
      shown = buildRequest({ baseUrl: project.upstreamBaseUrl, method: tool.method, path: tool.path, map: tool.requestMap, args: { ...args, ...placeholders } })
    } catch {
      // The placeholders did not fit (cannot happen for the real build to have succeeded, but never fail a call over a preview).
      shown = { method: built.method, url: `${project.upstreamBaseUrl.replace(/\/+$/, '')}${tool.path}`, headers: {} }
    }
  }

  const headers = Object.fromEntries(Object.entries(shown.headers).map(([k, v]) => [k, isSensitiveKey(k) ? MASK : v]))
  let url = rewriteQuery(shown.url, (name, pair) => (isSensitiveKey(name) ? `${pair.split('=')[0]}=${MASK}` : pair))

  const { credential } = project
  if (credential.type === 'BEARER') headers['authorization'] = `Bearer ${CREDENTIAL_PLACEHOLDER}`
  else if (credential.type === 'CUSTOM_HEADER' && credential.headerName) headers[credential.headerName.toLowerCase()] = CREDENTIAL_PLACEHOLDER
  else if (credential.type === 'QUERY_PARAM' && credential.queryParamName) {
    const name = credential.queryParamName
    url = rewriteQuery(url, (n, pair) => (n === name ? null : pair))
    url += `${url.includes('?') ? '&' : '?'}${encodeURIComponent(name)}=${CREDENTIAL_PLACEHOLDER}`
  }

  const redact = (text: string) => redactSecrets(text, secrets)
  return {
    method: shown.method,
    url: redact(url),
    headers: Object.fromEntries(Object.entries(headers).map(([k, v]) => [k, redact(v)])),
    ...(shown.body !== undefined ? { body: redact(previewBody(shown.body, headers['content-type'])) } : {}),
  }
}

function previewResponse(res: SsrfResponse, secrets: readonly string[]): ResponsePreview {
  const headers = Object.fromEntries(
    Object.entries(res.headers)
      .filter(([name]) => isShownResponseHeader(name.toLowerCase()))
      .map(([name, value]) => [name.toLowerCase(), redactSecrets(value, secrets)])
  )
  const textual = res.body.length > 0 && isTextual(res.headers['content-type'], res.body)
  // Redact the whole text first, then cut, so a secret that straddles the cut is not half shown.
  const text = textual ? redactSecrets(res.text(), secrets) : undefined
  const truncated = text !== undefined && text.length > DISPLAY_BODY_CHARS
  return {
    status: res.status,
    headers,
    ...(text !== undefined ? { body: truncated ? text.slice(0, DISPLAY_BODY_CHARS) : text } : {}),
    bodyBytes: res.body.length,
    binary: res.body.length > 0 && !textual,
    truncated,
  }
}

/**
 * Run one tool call against the upstream API.
 *
 * Every failure is returned as an `isError` result, never thrown, so one bad call cannot
 * take the request down. Messages are written here from fixed text and never include the
 * request URL, headers or the upstream's own error text unscrubbed, because any of those
 * can carry the upstream credential.
 */
export async function executeTool(
  project: ProjectConfig,
  tool: CachedTool,
  rawArgs: Record<string, unknown> | undefined,
  deps: Deps
): Promise<ToolOutcome> {
  return (await callUpstream(project, tool, rawArgs, deps)).outcome
}

/**
 * The one place an upstream call is made: argument check, request build, credential, SSRF-safe
 * fetch, response handling. The MCP path uses `outcome` only; the dashboard playground also asks
 * for `preview` to see the request and response (see RequestPreview and ResponsePreview).
 */
export async function callUpstream(
  project: ProjectConfig,
  tool: CachedTool,
  rawArgs: Record<string, unknown> | undefined,
  { config, log, validators }: Deps,
  options: { preview?: boolean } = {}
): Promise<UpstreamCall> {
  const check = validators.get(tool)(rawArgs ?? {})
  if (!check.valid) return { outcome: fail(`Invalid arguments for "${tool.name}": ${check.errorMessage}`, 'VALIDATION') }

  if (!project.upstreamBaseUrl) {
    return { outcome: fail('This project has no upstream base URL configured, so the tool cannot call the API.', 'NO_BASE_URL') }
  }

  const args = check.data as Record<string, unknown>
  let built
  try {
    built = buildRequest({
      baseUrl: project.upstreamBaseUrl,
      method: tool.method,
      path: tool.path,
      map: tool.requestMap,
      // Hidden parameters are fixed server-side: they come last so they always win over
      // anything the agent sent under the same name (the agent's schema does not list them).
      args: { ...args, ...hiddenArguments(tool.hidden) },
    })
  } catch (err) {
    if (err instanceof RequestBuildError) return { outcome: fail(err.message, 'REQUEST_BUILD') }
    throw err
  }

  // --- upstream credential ---
  // The only thing redacted from what comes back is the credential (plain and in its encoded forms), for the MCP
  // result and the Playground preview alike. A hidden parameter's value is not a secret: it is a fixed setting
  // stored as plain text, often an ordinary word ("available"), and masking it wherever it appears in a response
  // corrupts the data an agent or a person is reading. The request preview hides it structurally instead.
  const secrets: string[] = []
  const request = options.preview ? () => ({ request: previewRequest(project, tool, args, built, secrets) }) : () => ({})
  let url = built.url
  const headers = { ...built.headers }
  const { credential } = project
  if (credential.type !== 'NONE') {
    let secret: string
    try {
      if (!credential.encryptedValue) throw new Error('credential has no value')
      secret = decrypt(credential.encryptedValue, config.encryptionKey)
    } catch (err) {
      log.error({ projectId: project.projectId, err: err instanceof Error ? err.message : String(err) }, 'could not decrypt the upstream credential')
      return { outcome: fail('The upstream credential could not be loaded. Re-enter it in the project settings.', 'CREDENTIAL'), ...request() }
    }
    secrets.push(secret)

    if (credential.type === 'BEARER') headers['authorization'] = `Bearer ${secret}`
    else if (credential.type === 'CUSTOM_HEADER' && credential.headerName) headers[credential.headerName.toLowerCase()] = secret
    else if (credential.type === 'QUERY_PARAM' && credential.queryParamName) url = withQueryParam(url, credential.queryParamName, secret)
  }

  try {
    const response = await ssrfFetch(url, {
      method: built.method,
      headers,
      ...(built.body !== undefined ? { body: built.body } : {}),
      timeoutMs: config.toolTimeoutMs,
      maxBytes: config.toolMaxResponseBytes,
      followRedirects: false,
    })
    return {
      outcome: formatResponse(response, secrets),
      ...request(),
      ...(options.preview ? { response: previewResponse(response, secrets) } : {}),
    }
  } catch (err) {
    if (err instanceof SsrfError) {
      log.warn({ projectId: project.projectId, tool: tool.name, code: err.code }, 'upstream call refused or failed')
      return { outcome: fail(describeSsrfError(err, config), classOfSsrfError(err)), ...request() }
    }
    const code = (err as { code?: string } | null)?.code
    log.warn({ projectId: project.projectId, tool: tool.name, code }, 'upstream call failed')
    return { outcome: fail('Could not reach the upstream API.', 'UNREACHABLE'), ...request() }
  }
}
