import { validateEnv, z } from '@mcp-gateway/shared'

// Auth.js v5 reads AUTH_SECRET / AUTH_URL / AUTH_GITHUB_*. The v4 names
// (NEXTAUTH_SECRET, GITHUB_CLIENT_ID, ...) are not recognised and fail at
// runtime with a bare "MissingSecret", so they are rejected here by name.
const schema = z.object({
  AUTH_SECRET: z.string().min(32, 'must be at least 32 characters (openssl rand -hex 32)'),
  AUTH_URL: z.url('must be an absolute URL, e.g. http://localhost:3000'),
  AUTH_GITHUB_ID: z.string().min(1).optional(),
  AUTH_GITHUB_SECRET: z.string().min(1).optional(),

  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),

  ENCRYPTION_KEY: z
    .string()
    .regex(/^[0-9a-f]{64}$/i, 'must be 64 hex characters (32 bytes, openssl rand -hex 32)'),

  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
})

export type WebEnv = z.infer<typeof schema>

export function parseWebEnv(source: Record<string, string | undefined>): WebEnv {
  return validateEnv({
    schema,
    appName: 'web',
    envFile: '.env at the repo root (loaded by apps/web/src/instrumentation-node.ts)',
    source,
  })
}

let cached: WebEnv | undefined

export function env(): WebEnv {
  cached ??= parseWebEnv(process.env)
  return cached
}
