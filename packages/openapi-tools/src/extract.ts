import type { ToolDefinition, JsonSchema } from './types.js'
import { isRef } from './schema.js'
import { describeOperation } from './request-map.js'

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

      const properties: Record<string, JsonSchema> = {}
      const required: string[] = []
      for (const { binding, schema, required: isRequired } of describeOperation(item, op).args) {
        properties[binding.arg] = schema
        if (isRequired) required.push(binding.arg)
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

      tools.push({
        operationId: operationId ?? `${method}_${path}`,
        method: method.toUpperCase(),
        path,
        name: finalName,
        description,
        inputSchema,
      })
    }
  }

  return tools
}
