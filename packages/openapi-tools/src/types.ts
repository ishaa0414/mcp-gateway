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

/** A tool row to write: the extracted definition plus the spec baseline for name/description. */
export interface ToolWrite extends ToolDefinition {
  /** What the spec produced for name/description; the baseline for detecting user edits. */
  specName: string
  specDescription: string
}

/** A spec-derived name that was already taken, so the tool was given a suffixed one. */
export interface NameCollision {
  operationId: string
  /** The name the spec asked for. */
  wanted: string
  /** The unique name the tool received instead. */
  assigned: string
}

export interface MergeResult {
  /** Operations that are new in the spec. */
  create: ToolWrite[]
  /** Existing tools whose spec-derived fields changed. Unchanged tools are omitted. */
  update: ToolWrite[]
  /** operationIds that were active and are no longer in the spec. */
  markRemoved: string[]
  /** Tools whose spec-derived name clashed with another tool's name and got a suffix. */
  collisions: NameCollision[]
  added: number
  updated: number
  removed: number
  /** Present in both and nothing spec-derived changed (includes already-removed tools). */
  unchanged: number
}
