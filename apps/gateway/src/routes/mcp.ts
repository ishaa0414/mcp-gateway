import type { IncomingMessage } from 'node:http'
import type { PrismaClient } from '@mcp-gateway/db'
import { toNodeHandler } from '@modelcontextprotocol/node'
import type { AuthInfo } from '@modelcontextprotocol/server'
import type { FastifyInstance, FastifyReply } from 'fastify'
import { lookupApiKey } from '../auth/api-key.js'
import { parseBearerKey } from '../auth/bearer.js'
import type { LastUsedTracker } from '../auth/last-used.js'
import type { AuthFailureReason } from '../logging/call-logger.js'
import { rateLimitKey } from '@mcp-gateway/shared'
import { loadProjectConfig } from '../cache/project-config.js'
import type { SafeRedis } from '../cache/safe-redis.js'
import type { AppConfig } from '../config.js'
import { createGatewayHandler, type McpDeps, type McpPrincipal } from '../mcp/server.js'
import type { RateLimiter } from '../ratelimit/limiter.js'
import { toolCallsIn } from '../ratelimit/tool-calls.js'

export interface McpRouteDeps extends McpDeps {
  db: PrismaClient
  cache: SafeRedis
  config: AppConfig
  lastUsed: LastUsedTracker
  rateLimiter: RateLimiter
}

export const rpcError = (code: number, message: string) => ({ jsonrpc: '2.0' as const, error: { code, message }, id: null })

/** JSON-RPC server-error code for "too many tool calls" (the range -32000..-32099 is reserved for servers). */
export const RATE_LIMITED_CODE = -32029

const windowLabel = (windowMs: number) => (windowMs === 60_000 ? 'minute' : `${windowMs / 1000} seconds`)

export function registerMcpRoutes(app: FastifyInstance, deps: McpRouteDeps): void {
  const handler = createGatewayHandler(deps)
  const serve = toNodeHandler(handler, { onerror: (err) => deps.log.warn({ err: err.message }, 'mcp transport error') })
  app.addHook('onClose', async () => {
    await handler.close()
  })

  // Missing, malformed, unknown, revoked, or another project's key all look the same on
  // purpose, so the response never reveals which project slugs exist. The message names
  // every cause so a person reading it in a client knows what to check.
  const unauthorized = (reply: FastifyReply, slug: string, reason: AuthFailureReason) => {
    deps.callLog.authFailure(slug, reason)
    return reply
      .code(401)
      .header('www-authenticate', 'Bearer realm="mcp-gateway"')
      .send(
        rpcError(
          -32001,
          'API key missing, invalid or revoked. Send "Authorization: Bearer <api-key>" with an active API key for this project. ' +
            'This server uses API keys, not OAuth.'
        )
      )
  }

  /** One sampled log row for the first `tools/call` in a rejected request. */
  const recordRateLimited = (body: unknown, { project, apiKeyId }: McpPrincipal) => {
    const first = (Array.isArray(body) ? body : [body]).find(
      (m): m is { params?: { name?: unknown; arguments?: unknown } } => typeof m === 'object' && m !== null && (m as { method?: unknown }).method === 'tools/call'
    )
    const name = typeof first?.params?.name === 'string' ? first.params.name : ''
    const tool = project.tools.find((t) => t.name === name)
    deps.callLog.rateLimited({ projectId: project.projectId, apiKeyId, toolName: name, ...(tool ? { tool } : {}), args: first?.params?.arguments })
  }

  app.post<{ Params: { projectSlug: string } }>('/mcp/:projectSlug', async (request, reply) => {
    const slug = request.params.projectSlug
    const token = parseBearerKey(request.headers.authorization)
    if (!token) return unauthorized(reply, slug, 'AUTH_MISSING')

    let principal: McpPrincipal
    let rateLimitPerMin: number
    try {
      const key = await lookupApiKey(token, deps)
      if (!key) return unauthorized(reply, slug, 'AUTH_INVALID')
      // Logged under the URL's project, without the key's id: the key belongs to another tenant.
      if (key.slug !== slug) return unauthorized(reply, slug, 'AUTH_WRONG_PROJECT')

      const project = await loadProjectConfig(key.slug, deps)
      if (!project) return unauthorized(reply, slug, 'AUTH_INVALID')

      deps.lastUsed.touch(key.id)
      principal = { project, apiKeyId: key.id }
      rateLimitPerMin = key.rateLimitPerMin
    } catch (err) {
      request.log.error({ err: err instanceof Error ? err.message : String(err) }, 'could not authenticate or load the project')
      return reply.code(503).send(rpcError(-32603, 'The gateway is temporarily unavailable'))
    }

    // Rate limit, after authentication (so only real keys create counters) and before anything
    // reaches the SDK or the upstream. Only tools/call counts; the limiter never throws.
    const { count, firstId } = toolCallsIn(request.body)
    if (count > 0) {
      const decision = await deps.rateLimiter.check(rateLimitKey(principal.apiKeyId), rateLimitPerMin, count)
      if (!decision.allowed) {
        recordRateLimited(request.body, principal)
        const windowSeconds = deps.config.rateLimitWindowMs / 1000
        return reply
          .code(429)
          .header('retry-after', decision.retryAfterSeconds)
          .header('ratelimit-limit', decision.limit)
          .header('ratelimit-remaining', 0)
          .header('ratelimit-reset', decision.retryAfterSeconds)
          .send({
            jsonrpc: '2.0',
            id: firstId,
            error: {
              code: RATE_LIMITED_CODE,
              message:
                `Rate limit exceeded: ${decision.limit} tool calls per ${windowLabel(deps.config.rateLimitWindowMs)} for this API key. ` +
                `Retry in ${decision.retryAfterSeconds} second${decision.retryAfterSeconds === 1 ? '' : 's'}.`,
              data: { limit: decision.limit, windowSeconds, retryAfterSeconds: decision.retryAfterSeconds },
            },
          })
      }
      if ('limit' in decision) {
        reply
          .header('ratelimit-limit', decision.limit)
          .header('ratelimit-remaining', decision.remaining)
          .header('ratelimit-reset', decision.resetSeconds)
      }
    }

    // The SDK handler does no authentication; it receives the principal through authInfo
    // (toNodeHandler forwards req.auth). The key itself is not passed on.
    const authInfo: AuthInfo = { token: '', clientId: principal.apiKeyId, scopes: [], extra: { principal } }
    ;(request.raw as IncomingMessage & { auth?: AuthInfo }).auth = authInfo

    // hijack() hands the raw response to the SDK, so headers set so far (CORS) must be copied over.
    for (const [name, value] of Object.entries(reply.getHeaders())) {
      if (value !== undefined) reply.raw.setHeader(name, value)
    }
    reply.hijack()
    await serve(request.raw, reply.raw, request.body)
  })

  // Stateless: there is no session to resume or end, so the GET and DELETE that clients try
  // after initialising get the "not supported" answer the spec allows.
  const notAllowed = async (_request: unknown, reply: FastifyReply) =>
    reply.code(405).header('allow', 'POST').send(rpcError(-32000, 'Method not allowed: this MCP endpoint is stateless, use POST'))
  app.get('/mcp/:projectSlug', notAllowed)
  app.delete('/mcp/:projectSlug', notAllowed)
}
