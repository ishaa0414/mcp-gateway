import { config as loadEnv } from 'dotenv'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = fileURLToPath(new URL('.', import.meta.url))
loadEnv({ path: resolve(__dirname, '../../../.env') })

import Fastify from 'fastify'
import cors from '@fastify/cors'
import { db } from '@mcp-gateway/db'
import { Redis } from 'ioredis'

const fastify = Fastify({ logger: true })

await fastify.register(cors, { origin: true })

const redis = new Redis(process.env['REDIS_URL'] ?? 'redis://localhost:6379', {
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

const port = Number(process.env['GATEWAY_PORT'] ?? 4000)

try {
  await fastify.listen({ port, host: '0.0.0.0' })
} catch (err) {
  fastify.log.error(err)
  process.exit(1)
}
