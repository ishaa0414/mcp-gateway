import type { IncomingMessage } from 'node:http'
import type { PrismaClient } from '@mcp-gateway/db'
import { toNodeHandler } from '@modelcontextprotocol/node'
import type { AuthInfo } from '@modelcontextprotocol/server'
import type { FastifyInstance, FastifyReply } from 'fastify'
import { lookupApiKey } from '../auth/api-key.js'
import { parseBearerKey } from '../auth/bearer.js'
import type { LastUsedTracker } from '../auth/last-used.js'
import { loadProjectConfig } from '../cache/project-config.js'
import type { SafeRedis } from '../cache/safe-redis.js'
import type { AppConfig } from '../config.js'
import { createGatewayHandler, type McpDeps, type McpPrincipal } from '../mcp/server.js'

export interface McpRouteDeps extends McpDeps {
  db: PrismaClient
  cache: SafeRedis
  config: AppConfig
  lastUsed: LastUsedTracker
}

export const rpcError = (code: number, message: string) => ({ jsonrpc: '2.0' as const, error: { code, message }, id: null })

export function registerMcpRoutes(app: FastifyInstance, deps: McpRouteDeps): void {
  const handler = createGatewayHandler(deps)
  const serve = toNodeHandler(handler, { onerror: (err) => deps.log.warn({ err: err.message }, 'mcp transport error') })
  app.addHook('onClose', async () => {
    await handler.close()
  })

  // Missing, malformed, unknown, revoked, or another project's key all look the same on
  // purpose, so the response never reveals which project slugs exist. The message names
  // every cause so a person reading it in a client knows what to check.
  const unauthorized = (reply: FastifyReply) =>
    reply
      .code(401)
      .header('www-authenticate', 'Bearer realm="mcp-gateway"')
      .send(
        rpcError(
          -32001,
          'API key missing, invalid or revoked. Send "Authorization: Bearer <api-key>" with an active API key for this project. ' +
            'This server uses API keys, not OAuth.'
        )
      )

  app.post<{ Params: { projectSlug: string } }>('/mcp/:projectSlug', async (request, reply) => {
    const token = parseBearerKey(request.headers.authorization)
    if (!token) return unauthorized(reply)

    let principal: McpPrincipal
    try {
      const key = await lookupApiKey(token, deps)
      if (!key || key.slug !== request.params.projectSlug) return unauthorized(reply)

      const project = await loadProjectConfig(key.slug, deps)
      if (!project) return unauthorized(reply)

      deps.lastUsed.touch(key.id)
      principal = { project, apiKeyId: key.id }
    } catch (err) {
      request.log.error({ err: err instanceof Error ? err.message : String(err) }, 'could not authenticate or load the project')
      return reply.code(503).send(rpcError(-32603, 'The gateway is temporarily unavailable'))
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
