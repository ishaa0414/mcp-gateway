// Kept free of Node/parser imports so the dashboard (a client component) can use it via the
// "@mcp-gateway/openapi-tools/agent-schema" subpath, exactly as the gateway does.

interface ObjectSchema {
  type: string
  properties?: Record<string, unknown>
  required?: string[]
  [key: string]: unknown
}

/**
 * The schema an agent sees for a tool: the full input schema minus hidden parameters (their
 * values are fixed on the server). Both the dashboard preview and the gateway's `tools/list`
 * call this, so what you preview is what agents get.
 */
export function toAgentSchema(inputSchema: object, hiddenParams: object): ObjectSchema {
  const schema = inputSchema as ObjectSchema
  const hidden = new Set(Object.keys(hiddenParams))
  if (hidden.size === 0) return schema

  const properties = Object.fromEntries(Object.entries(schema.properties ?? {}).filter(([name]) => !hidden.has(name)))
  const required = (schema.required ?? []).filter((name) => !hidden.has(name))

  return { type: 'object', properties, ...(required.length ? { required } : {}) }
}
