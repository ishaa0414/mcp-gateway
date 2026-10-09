/** Runtime settings the request path needs. Built from env in index.ts; tests pass their own. */
export interface AppConfig {
  /** 64 hex characters; decrypts upstream credentials. */
  encryptionKey: string
  /** One deadline for a whole upstream call. */
  toolTimeoutMs: number
  /** Largest upstream response the gateway will read. */
  toolMaxResponseBytes: number
  /** Safety-net TTL for cached project configuration (invalidation normally clears it sooner). */
  configCacheTtlSeconds: number
  /** TTL for cached API key lookups. Bounds how long a revoked key can still work if invalidation fails. */
  apiKeyCacheTtlSeconds: number
  /** Minimum time between lastUsedAt writes for one key. */
  lastUsedIntervalMs: number
  /** Length of the rate-limit window (60 s in production; tests shorten it). */
  rateLimitWindowMs: number
  /** After a Redis failure, how long rate limiting is skipped before Redis is tried again. */
  rateLimitBreakerMs: number
  /** Clock for the rate limiter. Tests only: lets them move time without sleeping. */
  rateLimitNow?: () => number
}

/** The slice of a pino/Fastify logger the gateway uses. */
export interface Logger {
  info(obj: object, msg?: string): void
  warn(obj: object, msg?: string): void
  error(obj: object, msg?: string): void
}
