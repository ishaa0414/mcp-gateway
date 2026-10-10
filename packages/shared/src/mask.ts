/**
 * Turn the arguments an agent sent into something safe and small enough to store.
 *
 * - Values under sensitive keys are masked, and so are values the tool's schema marks as
 *   `format: password` (or `writeOnly`).
 * - Strings that look like a credential (API key, Bearer/Basic value, JWT) are masked wherever they are.
 * - Everything is bounded. The walk stops at the limits below instead of visiting the whole
 *   input and cutting afterwards, so a 1 MB argument costs about as much as a small one.
 */

export const MASK = '[MASKED]'

export interface MaskLimits {
  /** Nesting levels kept; deeper values become a marker. */
  maxDepth: number
  /** Characters kept per string. */
  maxStringChars: number
  /** Array items kept. */
  maxArrayItems: number
  /** Object keys kept. */
  maxObjectKeys: number
  /** Rough size of the result in characters; the walk stops once it is spent. */
  maxTotalChars: number
}

export const DEFAULT_MASK_LIMITS: MaskLimits = {
  maxDepth: 6,
  maxStringChars: 200,
  maxArrayItems: 20,
  maxObjectKeys: 50,
  maxTotalChars: 4096,
}

/** Compared after lower-casing and removing `-`, `_` and spaces, and matched as a substring. */
const SENSITIVE_KEY_PARTS = [
  'authorization',
  'password',
  'passwd',
  'passphrase',
  'token',
  'secret',
  'apikey',
  'accesskey',
  'privatekey',
  'cookie',
  'credential',
]

export function isSensitiveKey(key: string): boolean {
  const normalised = key.toLowerCase().replace(/[-_\s]/g, '')
  return SENSITIVE_KEY_PARTS.some((part) => normalised.includes(part))
}

const CREDENTIAL_VALUE_PATTERNS: RegExp[] = [
  /mcpg_[A-Za-z0-9_-]{8,}/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{6,}/gi,
  // Capitalised as in a header, so prose like "the basic implementation" is left alone.
  /\bBasic\s+[A-Za-z0-9+/]{8,}={0,2}/g,
  /\beyJ[\w-]{5,}\.[\w-]{5,}(?:\.[\w-]*)?/g,
]

// A credential longer than this is cut at maxStringChars anyway; looking further helps nothing.
const PATTERN_SCAN_CHARS = 1000

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** Schemas that describe `key` of an object schema (directly or through allOf/anyOf/oneOf). */
function childSchemas(schema: unknown, key: string): unknown[] {
  if (!isRecord(schema)) return []
  const found: unknown[] = []
  const props = schema['properties']
  if (isRecord(props) && key in props) found.push(props[key])
  for (const combiner of ['allOf', 'anyOf', 'oneOf'] as const) {
    const branches = schema[combiner]
    if (Array.isArray(branches)) for (const b of branches.slice(0, 10)) found.push(...childSchemas(b, key))
  }
  return found
}

function itemSchemas(schema: unknown): unknown[] {
  if (!isRecord(schema)) return []
  const found: unknown[] = isRecord(schema['items']) ? [schema['items']] : []
  for (const combiner of ['allOf', 'anyOf', 'oneOf'] as const) {
    const branches = schema[combiner]
    if (Array.isArray(branches)) for (const b of branches.slice(0, 10)) found.push(...itemSchemas(b))
  }
  return found
}

function marksSecret(schemas: unknown[]): boolean {
  return schemas.some((s) => isRecord(s) && (s['format'] === 'password' || s['writeOnly'] === true))
}

export interface MaskResult {
  value: Record<string, unknown>
  /** True when anything was cut because of a limit. */
  truncated: boolean
}

export function maskArguments(
  args: unknown,
  options: { schema?: unknown; limits?: Partial<MaskLimits> } = {}
): MaskResult {
  const limits = { ...DEFAULT_MASK_LIMITS, ...options.limits }
  let budget = limits.maxTotalChars
  let truncated = false

  const spend = (chars: number): boolean => {
    budget -= chars
    if (budget < 0) truncated = true
    return budget >= 0
  }

  function maskString(s: string): string {
    const scanned = s.length > PATTERN_SCAN_CHARS ? s.slice(0, PATTERN_SCAN_CHARS) : s
    let out = scanned
    for (const pattern of CREDENTIAL_VALUE_PATTERNS) out = out.replace(pattern, MASK)
    if (out.length > limits.maxStringChars) {
      truncated = true
      return `${out.slice(0, limits.maxStringChars)}…[truncated]`
    }
    if (s.length > scanned.length) {
      truncated = true
      return `${out}…[truncated]`
    }
    return out
  }

  function walk(value: unknown, schemas: unknown[], depth: number): unknown {
    if (value === null || typeof value === 'boolean' || typeof value === 'number') {
      spend(8)
      return value
    }
    if (typeof value === 'string') {
      const out = maskString(value)
      return spend(out.length) ? out : '[truncated]'
    }
    if (depth >= limits.maxDepth) {
      truncated = true
      return '[too deep]'
    }

    if (Array.isArray(value)) {
      const out: unknown[] = []
      const itemSchemaList = schemas.flatMap(itemSchemas)
      const keep = Math.min(value.length, limits.maxArrayItems)
      for (let i = 0; i < keep; i++) {
        if (budget <= 0) {
          truncated = true
          break
        }
        out.push(walk(value[i], itemSchemaList, depth + 1))
      }
      if (value.length > keep) {
        truncated = true
        out.push(`[${value.length - keep} more items]`)
      }
      return out
    }

    if (isRecord(value)) {
      const out: Record<string, unknown> = {}
      let kept = 0
      // for...in with an early exit: a huge object is abandoned after maxObjectKeys, not enumerated to the end.
      for (const key in value) {
        if (!Object.hasOwn(value, key)) continue
        if (kept >= limits.maxObjectKeys || budget <= 0) {
          truncated = true
          out['…'] = '[more keys omitted]'
          break
        }
        kept++
        const shortKey = key.length > 64 ? `${key.slice(0, 64)}…` : key
        spend(shortKey.length)
        const keySchemas = schemas.flatMap((s) => childSchemas(s, key))
        const masked = isSensitiveKey(key) || marksSecret(keySchemas) ? MASK : walk(value[key], keySchemas, depth + 1)
        // defineProperty, because assigning to a "__proto__" key from parsed JSON would change the prototype.
        Object.defineProperty(out, shortKey, { value: masked, enumerable: true, writable: true, configurable: true })
      }
      return out
    }

    // undefined, functions, symbols, bigint: not JSON, not worth keeping.
    return null
  }

  const root = isRecord(args) ? args : {}
  const value = walk(root, options.schema === undefined ? [] : [options.schema], 0) as Record<string, unknown>
  return { value, truncated }
}
