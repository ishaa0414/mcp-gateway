import type { PrismaClient } from '@mcp-gateway/db'
import cors from '@fastify/cors'
import Fastify, { type FastifyError, type FastifyInstance, type FastifyServerOptions } from 'fastify'
import type { Redis } from 'ioredis'
import { LastUsedTracker } from './auth/last-used.js'
import { SafeRedis } from './cache/safe-redis.js'
import type { AppConfig } from './config.js'
import { ValidatorCache } from './mcp/call-tool.js'
import { registerMcpRoutes, rpcError } from './routes/mcp.js'

export interface AppDeps {
  db: PrismaClient
  redis: Redis
  config: AppConfig
  logger?: FastifyServerOptions['logger']
}

const MAX_BODY_BYTES = 1024 * 1024

export async function buildApp({ db, redis, config, logger }: AppDeps): Promise<FastifyInstance> {
  const app = Fastify({
    // Never log credentials, even if a future serializer starts including headers.
    logger: logger ?? { level: 'info', redact: ['req.headers.authorization', 'req.headers.cookie'] },
    bodyLimit: MAX_BODY_BYTES,
  })

  await app.register(cors, {
    origin: true,
    methods: ['POST', 'GET', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['authorization', 'content-type', 'accept', 'mcp-protocol-version', 'mcp-session-id', 'last-event-id'],
    exposedHeaders: ['mcp-session-id', 'www-authenticate'],
  })

  // Parse and size errors on the MCP endpoint are answered in JSON-RPC, like everything else there.
  app.setErrorHandler((error: FastifyError, request, reply) => {
    const status = error.statusCode ?? 500
    if (status >= 500) request.log.error({ err: error.message }, 'request failed')
    if (status === 413) return reply.code(413).send(rpcError(-32600, 'Request body too large'))
    if (status === 415) return reply.code(415).send(rpcError(-32600, 'Unsupported media type: send application/json'))
    if (status >= 400 && status < 500) return reply.code(400).send(rpcError(-32700, 'Parse error: the request body is not valid JSON'))
    return reply.code(500).send(rpcError(-32603, 'Internal error'))
  })

  // There is no OAuth here (API keys only). Clients that get a 401 probe discovery URLs such as
  // /.well-known/oauth-protected-resource; a prompt, explicit 404 tells them to stop.
  app.setNotFoundHandler((_request, reply) => reply.code(404).send({ error: 'not_found', message: 'Not found. This server uses API keys, not OAuth.' }))

  const log = app.log
  const cache = new SafeRedis(redis, log)
  const validators = new ValidatorCache()
  const lastUsed = new LastUsedTracker(db, config.lastUsedIntervalMs, log)

  registerMcpRoutes(app, { db, cache, config, log, validators, lastUsed })

  app.get('/health', async (_req, reply) => {
    const status: Record<string, string> = {}

    try {
      await db.$queryRaw`SELECT 1`
      status['postgres'] = 'ok'
    } catch (err) {
      app.log.error(err, 'Postgres health check failed')
      status['postgres'] = 'error'
    }

    try {
      const pong = await redis.ping()
      status['redis'] = pong === 'PONG' ? 'ok' : 'error'
    } catch (err) {
      app.log.error(err, 'Redis health check failed')
      status['redis'] = 'error'
    }

    const allOk = Object.values(status).every((v) => v === 'ok')
    return reply.status(allOk ? 200 : 503).send(status)
  })

  return app
}
