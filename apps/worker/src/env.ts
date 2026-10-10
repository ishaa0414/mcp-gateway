import { config as loadEnv } from 'dotenv'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DEFAULT_LOG_RETENTION_DAYS, validateEnv, z } from '@mcp-gateway/shared'

// src/ (tsx dev) and dist/ (compiled) sit at the same depth, so one path works
// for both: apps/worker/{src,dist} → apps/worker → apps → repo root.
const here = fileURLToPath(new URL('.', import.meta.url))
export const ROOT_ENV_PATH = resolve(here, '../../../.env')

// Shell variables already set win over the file (dotenv does not override).
loadEnv({ path: ROOT_ENV_PATH })

const schema = z.object({
  DATABASE_URL: z.string().min(1),
  // Cap on Postgres connections (read by @mcp-gateway/db).
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(50).optional(),
  REDIS_URL: z.string().min(1),
  // Call logs older than this are deleted by the worker (queue mode).
  LOG_RETENTION_DAYS: z.coerce.number().int().min(1).max(3_650).default(DEFAULT_LOG_RETENTION_DAYS),
  WORKER_PORT: z.coerce.number().int().min(1).max(65535).default(4001),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
})

export const env = validateEnv({ schema, appName: 'worker', envFile: ROOT_ENV_PATH })
