import { config as loadEnv } from 'dotenv'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { validateEnv, z } from '@mcp-gateway/shared'

// src/ (tsx dev) and dist/ (compiled) sit at the same depth, so one path works
// for both: apps/gateway/{src,dist} → apps/gateway → apps → repo root.
const here = fileURLToPath(new URL('.', import.meta.url))
export const ROOT_ENV_PATH = resolve(here, '../../../.env')

// Shell variables already set win over the file (dotenv does not override).
loadEnv({ path: ROOT_ENV_PATH })

const schema = z.object({
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),
  ENCRYPTION_KEY: z
    .string()
    .regex(/^[0-9a-f]{64}$/i, 'must be 64 hex characters (32 bytes, openssl rand -hex 32)'),
  GATEWAY_PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  ALLOW_PRIVATE_UPSTREAMS: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
})

export const env = validateEnv({ schema, appName: 'gateway', envFile: ROOT_ENV_PATH })
