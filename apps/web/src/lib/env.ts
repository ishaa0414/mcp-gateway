import { z } from 'zod'

const schema = z.object({
  AUTH_SECRET: z.string().min(1, 'AUTH_SECRET is required'),
  AUTH_URL: z.string().url('AUTH_URL must be a valid URL'),
  AUTH_GITHUB_ID: z.string().optional(),
  AUTH_GITHUB_SECRET: z.string().optional(),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  REDIS_URL: z.string().min(1, 'REDIS_URL is required'),
  ENCRYPTION_KEY: z.string().length(64, 'ENCRYPTION_KEY must be 64 hex chars (32 bytes)'),
  GATEWAY_PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  ALLOW_PRIVATE_UPSTREAMS: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => v === 'true'),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('production'),
})

function parseEnv() {
  const result = schema.safeParse(process.env)
  if (!result.success) {
    const messages = result.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`)
    throw new Error(`Invalid environment variables:\n${messages.join('\n')}`)
  }
  return result.data
}

// Memoize — parse once at startup
let cached: ReturnType<typeof parseEnv> | null = null

export function env() {
  if (!cached) cached = parseEnv()
  return cached
}
