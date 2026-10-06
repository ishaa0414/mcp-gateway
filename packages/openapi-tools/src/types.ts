export interface ToolDefinition {
  operationId: string
  method: string
  path: string
  name: string        // MCP-safe: ^[a-zA-Z0-9_-]{1,64}$
  description: string
  inputSchema: JsonSchema
}

export interface JsonSchema {
  type: string
  properties?: Record<string, JsonSchema | { type: string; description?: string; enum?: unknown[] }>
  required?: string[]
  description?: string
  [key: string]: unknown
}

/** Fields written to an existing tool row when its spec-derived data changed. */
export interface ToolUpdate extends ToolDefinition {
  /** What the spec produced for name/description; the baseline for detecting user edits. */
  specName: string
  specDescription: string
}

export interface MergeResult {
  /** Operations that are new in the spec. */
  create: ToolDefinition[]
  /** Existing tools whose spec-derived fields changed. Unchanged tools are omitted. */
  update: ToolUpdate[]
  /** operationIds that were active and are no longer in the spec. */
  markRemoved: string[]
  added: number
  updated: number
  removed: number
  /** Present in both and nothing spec-derived changed (includes already-removed tools). */
  unchanged: number
}
