import type { ToolDefinition, JsonSchema } from './types.js'

/** Sanitise a raw string into a valid MCP tool name. */
export function sanitizeName(raw: string): string {
  let name = raw.replace(/[^a-zA-Z0-9_-]/g, '_').replace(/^[^a-zA-Z_]+/, '')
  if (!name) name = 'tool'
  return name.slice(0, 64)
}

/** Generate a name from HTTP method + path when no operationId is available. */
function nameFromMethodPath(method: string, path: string): string {
  const parts = path
    .replace(/\{([^}]+)\}/g, 'by_$1')
    .split('/')
    .filter(Boolean)
  return sanitizeName([method.toLowerCase(), ...parts].join('_'))
}

function isRef(v: unknown): v is { '$ref': string } {
  return typeof v === 'object' && v !== null && '$ref' in v
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function schemaToJsonSchema(schema: Record<string, any> | undefined): JsonSchema {
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

interface ParamEntry {
  name: string
  schema: JsonSchema
  required: boolean
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extractParams(parameters: any[] = []): ParamEntry[] {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return parameters.flatMap((p: any) => {
    if (isRef(p)) return []
    return [{
      name: p['name'] as string,
      schema: schemaToJsonSchema(p['schema'] as Record<string, unknown> | undefined),
      required: (p['required'] as boolean | undefined) ?? false,
    }]
  })
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extractBodyParams(requestBody: any): ParamEntry[] {
  if (!requestBody || isRef(requestBody)) return []
  const content = requestBody['content'] as Record<string, unknown> | undefined
  const media = content?.['application/json'] ?? content?.['application/x-www-form-urlencoded']
  if (!media) return []
  const schema = (media as Record<string, unknown>)['schema'] as Record<string, unknown> | undefined
  if (!schema || isRef(schema)) return []

  if (schema['type'] === 'object' || schema['properties']) {
    const props = schema['properties'] as Record<string, unknown> | undefined
    const requiredFields = (schema['required'] as string[] | undefined) ?? []
    return Object.entries(props ?? {}).map(([name, val]) => ({
      name,
      schema: isRef(val) ? { type: 'string' } : schemaToJsonSchema(val as Record<string, unknown>),
      required: requiredFields.includes(name),
    }))
  }

  return [{
    name: 'body',
    schema: schemaToJsonSchema(schema),
    required: (requestBody['required'] as boolean | undefined) ?? false,
  }]
}

/** Extract one ToolDefinition per operation from a dereferenced OpenAPI 3.x document. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function extractTools(doc: Record<string, any>): ToolDefinition[] {
  const paths = doc['paths'] as Record<string, unknown> | undefined
  if (!paths) return []

  const tools: ToolDefinition[] = []
  const seenNames = new Set<string>()

  const methods = ['get', 'post', 'put', 'patch', 'delete', 'options', 'head'] as const

  for (const [path, pathItem] of Object.entries(paths)) {
    if (!pathItem || isRef(pathItem)) continue
    const item = pathItem as Record<string, unknown>

    for (const method of methods) {
      const op = item[method] as Record<string, unknown> | undefined
      if (!op) continue

      const operationId = op['operationId'] as string | undefined
      const rawName = operationId ? sanitizeName(operationId) : nameFromMethodPath(method, path)

      // Ensure uniqueness by appending a counter
      let finalName = rawName
      let counter = 2
      while (seenNames.has(finalName)) {
        finalName = `${rawName.slice(0, 61)}_${counter++}`
      }
      seenNames.add(finalName)

      // Merge path-level + operation-level parameters
      const pathParams = extractParams(item['parameters'] as unknown[] | undefined)
      const opParams = extractParams(op['parameters'] as unknown[] | undefined)
      const paramMap = new Map<string, ParamEntry>()
      for (const p of [...pathParams, ...opParams]) paramMap.set(p.name, p)

      const bodyParams = extractBodyParams(op['requestBody'])
      const allParams = [...paramMap.values(), ...bodyParams]

      const properties: Record<string, JsonSchema> = {}
      const required: string[] = []
      for (const { name, schema, required: req } of allParams) {
        properties[name] = schema
        if (req) required.push(name)
      }

      const inputSchema: JsonSchema = {
        type: 'object',
        properties,
        ...(required.length ? { required } : {}),
      }

      const description =
        (op['summary'] as string | undefined) ??
        (op['description'] as string | undefined) ??
        `${method.toUpperCase()} ${path}`

      const tool: ToolDefinition = {
        operationId: operationId ?? `${method}_${path}`,
        method: method.toUpperCase(),
        path,
        name: finalName,
        description,
        inputSchema,
      }

      tools.push(tool)
    }
  }

  return tools
}

