import type { JsonSchema } from './types.js'

export function isRef(v: unknown): v is { '$ref': string } {
  return typeof v === 'object' && v !== null && '$ref' in v
}

/** Reduce an OpenAPI schema object to the JSON Schema subset we hand to agents. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function schemaToJsonSchema(schema: Record<string, any> | undefined): JsonSchema {
  if (!schema || isRef(schema)) return { type: 'object' }

  const result: JsonSchema = { type: (schema['type'] as string) ?? 'string' }

  if (schema['description']) result.description = schema['description'] as string
  if (schema['enum']) result.enum = schema['enum'] as unknown[]

  if (schema['type'] === 'object' || schema['properties']) {
    result.type = 'object'
    result.properties = {}
    const props = schema['properties'] as Record<string, unknown> | undefined
    if (props) {
      for (const [key, val] of Object.entries(props)) {
        if (isRef(val)) {
          result.properties[key] = { type: 'string', description: 'Reference' }
        } else {
          result.properties[key] = schemaToJsonSchema(val as Record<string, unknown>)
        }
      }
    }
    if (schema['required']) result.required = schema['required'] as string[]
  } else if (schema['type'] === 'array') {
    result.items = schema['items']
      ? schemaToJsonSchema(schema['items'] as Record<string, unknown>)
      : { type: 'string' }
  }

  return result
}
