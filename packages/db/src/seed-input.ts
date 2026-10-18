import { isSensitiveKey, maskArguments } from '@mcp-gateway/shared/mask'

/**
 * Development helper for the analytics seed: arguments a real agent could have sent to a tool,
 * built from the tool's own input schema (its parameter names, types, enums and bounds), and then
 * passed through the gateway's masker, so the stored row looks exactly like a logged one.
 */

type Random = () => number
type Schema = Record<string, unknown>

const isRecord = (v: unknown): v is Schema => typeof v === 'object' && v !== null && !Array.isArray(v)

const USERNAMES = ['alice', 'bob', 'carol', 'dave', 'erin']
const NAMES = ['Rex', 'Milo', 'Luna', 'Bella', 'Charlie']
const WORDS = ['sample', 'example', 'test', 'demo']

function sampleValue(name: string, schema: unknown, random: Random, depth: number): unknown {
  const s = isRecord(schema) ? schema : {}
  const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)]!

  if (Array.isArray(s['enum']) && s['enum'].length > 0) return pick(s['enum'])

  switch (s['type']) {
    case 'integer':
    case 'number': {
      const lo = typeof s['minimum'] === 'number' ? s['minimum'] : 1
      const hi = typeof s['maximum'] === 'number' ? s['maximum'] : Math.max(lo, 500)
      return lo + Math.floor(random() * (hi - lo + 1))
    }
    case 'boolean':
      return random() < 0.5
    case 'array': {
      if (depth >= 2) return []
      const count = 1 + Math.floor(random() * 2)
      return Array.from({ length: count }, () => sampleValue(name, s['items'], random, depth + 1))
    }
    case 'object':
      return depth >= 2 ? {} : sampleProperties(s, [], random, depth + 1)
    default: {
      // A string. A secret gets a realistic plain value: the masker, not the seed, hides it.
      if (isSensitiveKey(name) || s['format'] === 'password') return `${pick(WORDS)}-${Math.floor(random() * 1e6)}-Pw!`
      if (s['format'] === 'email') return `${pick(USERNAMES)}@example.com`
      if (s['format'] === 'date-time') return new Date(Date.UTC(2026, 9, 1) + Math.floor(random() * 10 * 86400_000)).toISOString()
      if (s['format'] === 'date') return new Date(Date.UTC(2026, 9, 1) + Math.floor(random() * 10 * 86400_000)).toISOString().slice(0, 10)
      if (/user/i.test(name)) return pick(USERNAMES)
      if (/name/i.test(name)) return pick(NAMES)
      if (/url|uri/i.test(name)) return `https://example.com/photos/${Math.floor(random() * 1000)}.jpg`
      return `${pick(WORDS)}-${Math.floor(random() * 1000)}`
    }
  }
}

function sampleProperties(schema: Schema, hidden: readonly string[], random: Random, depth: number): Record<string, unknown> {
  const properties = isRecord(schema['properties']) ? schema['properties'] : {}
  const required = new Set(Array.isArray(schema['required']) ? (schema['required'] as string[]) : [])
  const out: Record<string, unknown> = {}
  for (const [name, propSchema] of Object.entries(properties)) {
    if (hidden.includes(name)) continue // fixed on the server; the agent never sends it
    if (required.has(name) || random() < 0.5) out[name] = sampleValue(name, propSchema, random, depth)
  }
  return out
}

/** Arguments for one call of a tool with this input schema, as the gateway would store them. */
export function sampleToolInput(inputSchema: unknown, hiddenParams: unknown, random: Random): Record<string, unknown> {
  const schema = isRecord(inputSchema) ? inputSchema : {}
  const hidden = isRecord(hiddenParams) ? Object.keys(hiddenParams) : []
  return maskArguments(sampleProperties(schema, hidden, random, 0), { schema }).value
}
