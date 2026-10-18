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
      if (s['format'] === 'email' || /e-?mail/i.test(name)) return `${pick(USERNAMES)}@example.com`
      if (s['format'] === 'date-time') return new Date(Date.UTC(2026, 9, 1) + Math.floor(random() * 10 * 86400_000)).toISOString()
      if (s['format'] === 'date') return new Date(Date.UTC(2026, 9, 1) + Math.floor(random() * 10 * 86400_000)).toISOString().slice(0, 10)
      // 555-0100 to 555-0199 is the range reserved for fictional numbers.
      if (/phone|mobile|^tel/i.test(name)) return `+1-555-01${String(Math.floor(random() * 100)).padStart(2, '0')}`
      if (/user/i.test(name)) return pick(USERNAMES)
      if (/name/i.test(name)) return pick(NAMES)
      if (/url|uri/i.test(name)) return `https://example.com/photos/${Math.floor(random() * 1000)}.jpg`
      return `${pick(WORDS)}-${Math.floor(random() * 1000)}`
    }
  }
}

/** Names that identify the account a password belongs to, in priority order (compared lower-case, exactly). */
const IDENTITY_NAMES = [['username', 'user_name'], ['login'], ['email']]

const isString = (schema: unknown) => isRecord(schema) && schema['type'] === 'string'

/** The property a password is sent together with: the first identity name the schema has as a string. */
function identityProperty(properties: Schema, hidden: readonly string[]): string | undefined {
  for (const names of IDENTITY_NAMES) {
    const found = Object.keys(properties).find((n) => names.includes(n.toLowerCase()) && !hidden.includes(n) && isString(properties[n]))
    if (found) return found
  }
  return undefined
}

function sampleProperties(schema: Schema, hidden: readonly string[], random: Random, depth: number): Record<string, unknown> {
  const properties = isRecord(schema['properties']) ? schema['properties'] : {}
  const required = new Set(Array.isArray(schema['required']) ? (schema['required'] as string[]) : [])

  // Decide which properties are sent first, so a password never goes without who it belongs to.
  const included = new Set<string>()
  for (const name of Object.keys(properties)) {
    if (hidden.includes(name)) continue // fixed on the server; the agent never sends it
    if (required.has(name) || random() < 0.5) included.add(name)
  }
  if ([...included].some((n) => isSensitiveKey(n) && isString(properties[n]))) {
    const identity = identityProperty(properties, hidden)
    if (identity) included.add(identity)
  }

  const out: Record<string, unknown> = {}
  for (const name of Object.keys(properties)) {
    if (included.has(name)) out[name] = sampleValue(name, properties[name], random, depth)
  }

  // An email is the account's username at example.com, whatever order the properties come in.
  const username = Object.keys(out).find((n) => IDENTITY_NAMES[0]!.includes(n.toLowerCase()) && typeof out[n] === 'string')
  if (username) {
    for (const name of Object.keys(out)) {
      if (/e-?mail/i.test(name) && isString(properties[name])) out[name] = `${out[username] as string}@example.com`
    }
  }
  return out
}

/** Arguments for one call of a tool with this input schema, as the gateway would store them. */
export function sampleToolInput(inputSchema: unknown, hiddenParams: unknown, random: Random): Record<string, unknown> {
  const schema = isRecord(inputSchema) ? inputSchema : {}
  const hidden = isRecord(hiddenParams) ? Object.keys(hiddenParams) : []
  return maskArguments(sampleProperties(schema, hidden, random, 0), { schema }).value
}

/** A plain value of the wrong type for each type a seed can get wrong. */
const WRONG_TYPE: Record<string, unknown> = { string: 42, integer: 'abc', number: 'abc', boolean: 'abc' }

/** A property that can be sent the wrong way round: plain typed, with nothing else constraining its value, and not a secret. */
function isPlainTyped(name: string, schema: unknown): boolean {
  if (!isRecord(schema) || typeof schema['type'] !== 'string' || !(schema['type'] in WRONG_TYPE)) return false
  if (['enum', 'const', 'oneOf', 'anyOf', 'format'].some((k) => k in schema)) return false
  return !isSensitiveKey(name)
}

/**
 * Arguments the gateway would reject, with the message it would log: the gateway's own wording
 * (`Invalid arguments for "<tool>": ` + Ajv's `errorsText`) describing this input, either a required
 * property that is missing or a plain property sent with the wrong type. Returns null when the tool
 * has nothing to get wrong.
 */
export function sampleInvalidInput(
  toolName: string,
  inputSchema: unknown,
  hiddenParams: unknown,
  random: Random
): { input: Record<string, unknown>; errorMessage: string } | null {
  const schema = isRecord(inputSchema) ? inputSchema : {}
  const hidden = isRecord(hiddenParams) ? Object.keys(hiddenParams) : []
  const properties = isRecord(schema['properties']) ? schema['properties'] : {}
  const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)]!
  const finish = (input: Record<string, unknown>, detail: string) => ({
    input: maskArguments(input, { schema }).value,
    errorMessage: `Invalid arguments for "${toolName}": ${detail}`,
  })

  const required = (Array.isArray(schema['required']) ? (schema['required'] as string[]) : []).filter((n) => n in properties && !hidden.includes(n))
  if (required.length > 0) {
    const input = sampleProperties(schema, hidden, random, 0)
    const missing = pick(required)
    delete input[missing]
    return finish(input, `data must have required property '${missing}'`)
  }

  const candidates = Object.keys(properties).filter((n) => !hidden.includes(n) && isPlainTyped(n, properties[n]))
  if (candidates.length === 0) return null
  const input = sampleProperties(schema, hidden, random, 0)
  const name = pick(candidates)
  const type = (properties[name] as Schema)['type'] as string
  input[name] = WRONG_TYPE[type]
  return finish(input, `data/${name} must be ${type}`)
}
