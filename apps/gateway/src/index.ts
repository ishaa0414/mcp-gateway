// Must be first: loads the root .env and validates it before any module that
// reads process.env at import time (e.g. @mcp-gateway/db).
import { env } from './env.js'

import Fastify from 'fastify'
import cors from '@fastify/cors'
import { db } from '@mcp-gateway/db'
import { Redis } from 'ioredis'

const fastify = Fastify({ logger: true })

await fastify.register(cors, { origin: true })

const redis = new Redis(env.REDIS_URL, {
  maxRetriesPerRequest: 3,
  lazyConnect: true,
})

fastify.get('/health', async (_req, reply) => {
  const status: Record<string, string> = {}

  try {
    await db.$queryRaw`SELECT 1`
    status['postgres'] = 'ok'
  } catch (err) {
    fastify.log.error(err, 'Postgres health check failed')
    status['postgres'] = 'error'
  }

  try {
    const pong = await redis.ping()
    status['redis'] = pong === 'PONG' ? 'ok' : 'error'
  } catch (err) {
    fastify.log.error(err, 'Redis health check failed')
    status['redis'] = 'error'
  }

  const allOk = Object.values(status).every((v) => v === 'ok')
  return reply.status(allOk ? 200 : 503).send(status)
})

try {
  await fastify.listen({ port: env.GATEWAY_PORT, host: '0.0.0.0' })
} catch (err) {
  fastify.log.error(err)
  process.exit(1)
}
