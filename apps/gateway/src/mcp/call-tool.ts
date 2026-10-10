import { STATUS_CODES } from 'node:http'
import { decrypt } from '@mcp-gateway/crypto'
import { buildRequest, RequestBuildError } from '@mcp-gateway/openapi-tools'
import { sanitizeErrorMessage, ssrfFetch, SsrfError } from '@mcp-gateway/shared'
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
  { config, log, validators }: Deps
): Promise<ToolOutcome> {
  const check = validators.get(tool)(rawArgs ?? {})
  if (!check.valid) return fail(`Invalid arguments for "${tool.name}": ${check.errorMessage}`, 'VALIDATION')

  if (!project.upstreamBaseUrl) {
    return fail('This project has no upstream base URL configured, so the tool cannot call the API.', 'NO_BASE_URL')
  }

  let built
  try {
    built = buildRequest({
      baseUrl: project.upstreamBaseUrl,
      method: tool.method,
      path: tool.path,
      map: tool.requestMap,
      // Hidden parameters are fixed server-side: they come last so they always win over
      // anything the agent sent under the same name (the agent's schema does not list them).
      args: { ...(check.data as Record<string, unknown>), ...tool.hidden },
    })
  } catch (err) {
    if (err instanceof RequestBuildError) return fail(err.message, 'REQUEST_BUILD')
    throw err
  }

  // --- upstream credential ---
  const secrets: string[] = []
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
      return fail('The upstream credential could not be loaded. Re-enter it in the project settings.', 'CREDENTIAL')
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
    return formatResponse(response, secrets)
  } catch (err) {
    if (err instanceof SsrfError) {
      log.warn({ projectId: project.projectId, tool: tool.name, code: err.code }, 'upstream call refused or failed')
      return fail(describeSsrfError(err, config), classOfSsrfError(err))
    }
    const code = (err as { code?: string } | null)?.code
    log.warn({ projectId: project.projectId, tool: tool.name, code }, 'upstream call failed')
    return fail('Could not reach the upstream API.', 'UNREACHABLE')
  }
}
