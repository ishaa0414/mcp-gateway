export interface ToolDefinition {
  operationId: string
  method: string
  path: string
  name: string        // MCP-safe: ^[a-zA-Z0-9_-]{1,64}$
  description: string
  inputSchema: JsonSchema
  serversUrl?: string // from spec.servers[0].url on first import
}

export interface JsonSchema {
  type: string
  properties?: Record<string, JsonSchema | { type: string; description?: string; enum?: unknown[] }>
  required?: string[]
  description?: string
  [key: string]: unknown
}

export interface MergeResult {
  tools: MergedTool[]
  added: number
  updated: number
  removed: number
  unchanged: number
}

export interface MergedTool extends ToolDefinition {
  removedAt: Date | null
  /** true when user has customised name/description — preserve those edits */
  userEdited?: boolean
}
