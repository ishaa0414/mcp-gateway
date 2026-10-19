/**
 * Turning a tool's agent schema into form fields, and the typed values back into tool arguments.
 * Pure and free of server imports, so the page builds the fields on the server and the form uses
 * the same code in the browser. Only plain scalars and enums get their own control; everything
 * else (objects, arrays, unions, unknown types) is a JSON text field.
 */

export type FieldKind = 'string' | 'number' | 'integer' | 'boolean' | 'enum' | 'json'
export type EnumValue = string | number | boolean

export interface PlaygroundField {
  name: string
  kind: FieldKind
  required: boolean
  description?: string
  /** For `enum`: the allowed values, as the schema lists them. */
  options?: EnumValue[]
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const isEnumValue = (v: unknown): v is EnumValue => typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean'

function kindOf(schema: unknown): Pick<PlaygroundField, 'kind' | 'options'> {
  if (!isRecord(schema)) return { kind: 'json' }
  const options = schema['enum']
  if (Array.isArray(options) && options.length > 0 && options.every(isEnumValue)) return { kind: 'enum', options }
  // A union or composition has no single control.
  if (['oneOf', 'anyOf', 'allOf', 'not', '$ref'].some((k) => k in schema)) return { kind: 'json' }
  switch (schema['type']) {
    case 'string':
    case 'number':
    case 'integer':
    case 'boolean':
      return { kind: schema['type'] }
    default:
      return { kind: 'json' } // object, array, null, a list of types, or no type at all
  }
}

/** One field per property of the agent schema (hidden parameters are already gone from it). */
export function buildFields(agentSchema: unknown): PlaygroundField[] {
  if (!isRecord(agentSchema) || !isRecord(agentSchema['properties'])) return []
  const required = new Set(Array.isArray(agentSchema['required']) ? (agentSchema['required'] as unknown[]).filter((r): r is string => typeof r === 'string') : [])
  const fields = Object.entries(agentSchema['properties']).map(([name, schema]) => ({
    name,
    ...kindOf(schema),
    required: required.has(name),
    ...(isRecord(schema) && typeof schema['description'] === 'string' ? { description: schema['description'] } : {}),
  }))
  // Required fields first. (The database stores the schema as JSONB, which does not keep the spec's property order.)
  return [...fields.filter((f) => f.required), ...fields.filter((f) => !f.required)]
}

/** What the form holds for each field: text for most, the index of the chosen option for an enum ('' for none). */
export type FieldValues = Record<string, string>

export type ArgumentsResult = { ok: true; arguments: Record<string, unknown> } | { ok: false; errors: Record<string, string> }

/**
 * The tool arguments from the form values. A blank field is left out (the gateway then reports a
 * missing required property in its own words). The only errors here are the ones the browser must
 * catch because it cannot send them: text that is not a number or not JSON. Whether a value is
 * valid for the tool is the gateway's check, shown as it says it.
 */
export function toArguments(fields: readonly PlaygroundField[], values: FieldValues): ArgumentsResult {
  const args: Record<string, unknown> = {}
  const errors: Record<string, string> = {}

  for (const f of fields) {
    const raw = values[f.name] ?? ''
    if (raw.trim() === '') continue

    switch (f.kind) {
      case 'string':
        args[f.name] = raw
        break
      case 'number':
      case 'integer': {
        const n = Number(raw)
        if (Number.isNaN(n)) errors[f.name] = 'Enter a number.'
        else args[f.name] = n
        break
      }
      case 'boolean':
        args[f.name] = raw === 'true'
        break
      case 'enum': {
        const option = f.options?.[Number(raw)]
        if (option === undefined) errors[f.name] = 'Choose one of the listed values.'
        else args[f.name] = option
        break
      }
      case 'json':
        try {
          args[f.name] = JSON.parse(raw)
        } catch (err) {
          errors[f.name] = `Not valid JSON: ${err instanceof Error ? err.message : 'parse error'}`
        }
        break
    }
  }

  return Object.keys(errors).length > 0 ? { ok: false, errors } : { ok: true, arguments: args }
}
