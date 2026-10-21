import { DEFAULT_TOOL_CALL_TIMEOUT_MS, PLAYGROUND_MIN_SECRET_BYTES, validateEnv, z } from '@mcp-gateway/shared'

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

  // Where agents reach the gateway, shown in the connection instructions.
  GATEWAY_PUBLIC_URL: z.url('must be an absolute URL, e.g. http://localhost:4000').default('http://localhost:4000'),
  // Where the dashboard's server reaches the gateway for playground calls. Defaults to GATEWAY_PUBLIC_URL (see gatewayInternalUrl).
  GATEWAY_INTERNAL_URL: z.url({ protocol: /^https?$/, error: 'must be an absolute http(s) URL, e.g. http://localhost:4000' }).optional(),
  // Shared with the gateway; signs playground requests. Unset (or empty): the Playground shows "not configured".
  PLAYGROUND_SECRET: z
    .string()
    .optional()
    .transform((v) => (v === '' ? undefined : v))
    .refine((v) => v === undefined || Buffer.byteLength(v) >= PLAYGROUND_MIN_SECRET_BYTES, {
      message: `must be at least ${PLAYGROUND_MIN_SECRET_BYTES} bytes (openssl rand -hex 32)`,
    }),
  // The gateway's upstream timeout; the playground waits this long plus a margin. Keep it equal to the gateway's setting.
  TOOL_CALL_TIMEOUT_MS: z.coerce.number().int().min(100).max(120_000).default(DEFAULT_TOOL_CALL_TIMEOUT_MS),

  ENCRYPTION_KEY: z
    .string()
    .regex(/^[0-9a-f]{64}$/i, 'must be 64 hex characters (32 bytes, openssl rand -hex 32)'),

  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
})

export type WebEnv = z.infer<typeof schema>

/** The URL the dashboard's server calls the gateway on: GATEWAY_INTERNAL_URL, or else the public one. */
export const gatewayInternalUrl = (e: Pick<WebEnv, 'GATEWAY_INTERNAL_URL' | 'GATEWAY_PUBLIC_URL'>): string =>
  (e.GATEWAY_INTERNAL_URL ?? e.GATEWAY_PUBLIC_URL).replace(/\/+$/, '')

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
