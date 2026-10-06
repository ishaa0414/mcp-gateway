// Must be first: loads the root .env and validates it before any module that
// reads process.env at import time.
import { env } from './env.js'

import { Worker } from 'bullmq'
import { Redis } from 'ioredis'

const QUEUE_NAME = 'tool-call-logs'

const connection = new Redis(env.REDIS_URL, {
  maxRetriesPerRequest: null, // Required by BullMQ
})

const worker = new Worker(
  QUEUE_NAME,
  async (job) => {
    console.log(`[worker] Processing job ${job.id} (${job.name})`, job.data)
    // Phase 6: write to Postgres and update UsageRollup
  },
  { connection },
)

worker.on('completed', (job) => {
  console.log(`[worker] Job ${job.id} completed`)
})

worker.on('failed', (job, err) => {
  console.error(`[worker] Job ${job?.id} failed:`, err.message)
})

worker.on('error', (err) => {
  console.error('[worker] Worker error:', err.message)
})

console.log(`[worker] Listening on queue: ${QUEUE_NAME}`)
