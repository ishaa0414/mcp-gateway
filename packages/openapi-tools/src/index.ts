// OpenAPI → MCP tool conversion — implemented in Phase 2

export type OpenApiToolDefinition = {
  operationId: string
  method: string
  path: string
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

export const placeholder = 'openapi-tools stub — Phase 2'
