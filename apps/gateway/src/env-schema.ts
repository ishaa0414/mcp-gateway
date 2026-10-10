import { DEFAULT_LOG_RETENTION_DAYS, z } from '@mcp-gateway/shared'

const port = z.coerce.number().int().min(1).max(65535)

export const gatewayEnvSchema = z
  .object({
    DATABASE_URL: z.string().min(1),
    REDIS_URL: z.string().min(1),
    ENCRYPTION_KEY: z
      .string()
      .regex(/^[0-9a-f]{64}$/i, 'must be 64 hex characters (32 bytes, openssl rand -hex 32)'),
    // Cap on Postgres connections (read by @mcp-gateway/db). The default of 10 can exceed a free-tier database's limit.
    DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(50).optional(),
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
    // Call logging. `queue`: batches go to BullMQ and the worker writes them to Postgres.
    // `direct`: the gateway writes batches to Postgres itself and needs no worker (for hosts where BullMQ's
    // Redis polling is too expensive, such as a free Upstash plan). Deploy with `direct`.
    LOG_SINK: z.enum(['queue', 'direct']).default('queue'),
    // Call logs older than this are deleted: by the gateway itself in `direct` mode, by the worker in `queue` mode.
    LOG_RETENTION_DAYS: z.coerce.number().int().min(1).max(3_650).default(DEFAULT_LOG_RETENTION_DAYS),
    // Most events held in memory; when full, new ones are dropped and counted.
    LOG_BUFFER_MAX: z.coerce.number().int().min(10).max(100_000).default(1_000),
    LOG_BATCH_SIZE: z.coerce.number().int().min(1).max(1_000).default(100),
    LOG_FLUSH_INTERVAL_MS: z.coerce.number().int().min(100).max(60_000).default(2_000),
    // How long shutdown keeps trying to write what is still buffered.
    LOG_SHUTDOWN_FLUSH_MS: z.coerce.number().int().min(0).max(30_000).default(5_000),
  })
  .refine((e) => e.LOG_BATCH_SIZE <= e.LOG_BUFFER_MAX, {
    message: 'LOG_BATCH_SIZE must not exceed LOG_BUFFER_MAX',
    path: ['LOG_BATCH_SIZE'],
  })
  .refine((e) => !(e.NODE_ENV === 'production' && e.ALLOW_PRIVATE_UPSTREAMS), {
    message: 'ALLOW_PRIVATE_UPSTREAMS must not be true in production',
    path: ['ALLOW_PRIVATE_UPSTREAMS'],
  })
  .transform((e) => ({ ...e, port: e.GATEWAY_PORT ?? e.PORT ?? 4000 }))
