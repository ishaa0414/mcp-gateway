// Must be first: loads the root .env and validates it before any module that
// reads process.env at import time (@mcp-gateway/db reads DATABASE_URL).
import { env } from './env.js'

import { db } from '@mcp-gateway/db'
import { LOG_QUEUE_NAME } from '@mcp-gateway/shared'
import { Redis } from 'ioredis'
import { startLogWorker } from './log-worker.js'

const connection = new Redis(env.REDIS_URL, {
  maxRetriesPerRequest: null, // Required by BullMQ
})

const worker = startLogWorker(db, connection)
console.log(`[worker] Listening on queue: ${LOG_QUEUE_NAME}`)

// Finish the job in progress, then release connections.
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => {
    console.log(`[worker] ${signal}: shutting down`)
    worker
      .close()
      .then(async () => {
        connection.disconnect()
        await db.$disconnect()
        process.exit(0)
      })
      .catch((err: unknown) => {
        console.error('[worker] error during shutdown', err)
        process.exit(1)
      })
  })
}
