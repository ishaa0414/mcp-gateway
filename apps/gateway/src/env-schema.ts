import { z } from '@mcp-gateway/shared'

const port = z.coerce.number().int().min(1).max(65535)

export const gatewayEnvSchema = z
  .object({
    DATABASE_URL: z.string().min(1),
    REDIS_URL: z.string().min(1),
    ENCRYPTION_KEY: z
      .string()
      .regex(/^[0-9a-f]{64}$/i, 'must be 64 hex characters (32 bytes, openssl rand -hex 32)'),
    GATEWAY_PORT: port.optional(),
    // Render, Koyeb, Fly and similar hosts tell the container which port to bind through PORT.
    PORT: port.optional(),
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    ALLOW_PRIVATE_UPSTREAMS: z
      .enum(['true', 'false'])
      .default('false')
      .transform((v) => v === 'true'),
    TOOL_CALL_TIMEOUT_MS: z.coerce.number().int().min(100).max(120_000).default(15_000),
    TOOL_RESPONSE_MAX_BYTES: z.coerce.number().int().min(1024).max(10 * 1024 * 1024).default(1024 * 1024),
    CONFIG_CACHE_TTL_SECONDS: z.coerce.number().int().min(1).max(86_400).default(300),
    API_KEY_CACHE_TTL_SECONDS: z.coerce.number().int().min(1).max(3_600).default(30),
  })
  .refine((e) => !(e.NODE_ENV === 'production' && e.ALLOW_PRIVATE_UPSTREAMS), {
    message: 'ALLOW_PRIVATE_UPSTREAMS must not be true in production',
    path: ['ALLOW_PRIVATE_UPSTREAMS'],
  })
  .transform((e) => ({ ...e, port: e.GATEWAY_PORT ?? e.PORT ?? 4000 }))
