import { z } from 'zod'

export { z }

// Shared Zod schemas
export const ProjectSlugSchema = z
  .string()
  .regex(/^[a-z0-9-]{3,48}$/, 'Slug must be 3–48 lowercase alphanumeric characters or hyphens')

export const PaginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
})

export type Pagination = z.infer<typeof PaginationSchema>

export { ssrfFetch, assertPublicHttpUrl, SsrfError, isBlockedIpv4, isBlockedIpv6 } from './ssrf-fetch.js'
export type { SsrfFetchOptions, SsrfResponse } from './ssrf-fetch.js'

export { validateEnv, EnvValidationError } from './env.js'
export type { ValidateEnvOptions } from './env.js'

export { projectConfigKey, apiKeyCacheKey, rateLimitKey, invalidateProjectConfig, invalidateApiKey } from './cache-keys.js'
export type { RedisLike } from './cache-keys.js'

export { logEventSchema, logBatchSchema, sanitizeErrorMessage, LOG_ERROR_CLASSES, LOG_QUEUE_NAME, DEFAULT_LOG_RETENTION_DAYS, ERROR_MESSAGE_MAX_CHARS } from './log-event.js'
export type { LogEvent, LogErrorClass } from './log-event.js'

export { maskArguments, isSensitiveKey, MASK, DEFAULT_MASK_LIMITS } from './mask.js'
export type { MaskLimits, MaskResult } from './mask.js'
