import type { ToolDefinition, MergeResult, MergedTool } from './types.js'

export interface ExistingTool {
  operationId: string
  name: string
  description: string
  inputSchema: Record<string, unknown>
  enabled: boolean
  hiddenParams: Record<string, unknown>
  removedAt: Date | null
  userEdited?: boolean
}

/**
 * Merge a freshly-extracted list of tools from a new spec import into the
 * existing tool list stored in the database.
 *
 * Rules:
 * - New operationIds → add with removedAt = null
 * - Matching operationIds:
 *   - Preserve user edits (name / description) if userEdited = true
 *   - Update inputSchema from fresh spec
 *   - Clear removedAt (operation re-appeared in spec)
 * - OperationIds in existing but NOT in fresh → set removedAt = now
 */
export function mergeTools(existing: ExistingTool[], fresh: ToolDefinition[]): MergeResult {
  const freshMap = new Map(fresh.map((t) => [t.operationId, t]))
  const existingMap = new Map(existing.map((t) => [t.operationId, t]))

  const now = new Date()
  const result: MergedTool[] = []
  let added = 0, updated = 0, removed = 0, unchanged = 0

  // Process existing tools
  for (const ex of existing) {
    const freshTool = freshMap.get(ex.operationId)

    if (!freshTool) {
      if (ex.removedAt === null) {
        removed++
        result.push({
          operationId: ex.operationId,
          method: '',
          path: '',
          name: ex.name,
          description: ex.description,
          inputSchema: ex.inputSchema as import('./types.js').JsonSchema,
          removedAt: now,
          userEdited: ex.userEdited,
        })
      } else {
        unchanged++
        result.push({
          operationId: ex.operationId,
          method: '',
          path: '',
          name: ex.name,
          description: ex.description,
          inputSchema: ex.inputSchema as import('./types.js').JsonSchema,
          removedAt: ex.removedAt,
          userEdited: ex.userEdited,
        })
      }
    } else {
      const nameChanged = ex.name !== freshTool.name && !ex.userEdited
      const descChanged = ex.description !== freshTool.description && !ex.userEdited
      const schemaChanged =
        JSON.stringify(ex.inputSchema) !== JSON.stringify(freshTool.inputSchema)
      const wasRemoved = ex.removedAt !== null

      if (nameChanged || descChanged || schemaChanged || wasRemoved) {
        updated++
      } else {
        unchanged++
      }

      result.push({
        operationId: freshTool.operationId,
        method: freshTool.method,
        path: freshTool.path,
        name: ex.userEdited ? ex.name : freshTool.name,
        description: ex.userEdited ? ex.description : freshTool.description,
        inputSchema: freshTool.inputSchema,
        removedAt: null,
        userEdited: ex.userEdited,
        serversUrl: freshTool.serversUrl,
      })
    }
  }

  // Add brand-new operations
  for (const ft of fresh) {
    if (!existingMap.has(ft.operationId)) {
      added++
      result.push({ ...ft, removedAt: null })
    }
  }

  return { tools: result, added, updated, removed, unchanged }
}
