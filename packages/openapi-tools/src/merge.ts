import type { JsonSchema, MergeResult, ToolDefinition, ToolUpdate } from './types.js'

export interface ExistingTool {
  operationId: string
  method: string
  path: string
  name: string
  description: string
  /** What the spec produced for `name` on the last import. */
  specName: string
  /** What the spec produced for `description` on the last import. */
  specDescription: string
  inputSchema: Record<string, unknown>
  removedAt: Date | null
}

/**
 * Structural equality that ignores object key order. Postgres JSONB does not
 * preserve key order, so comparing JSON.stringify output reports every stored
 * schema as "changed" after a round trip through the database.
 */
export function isDeepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false
  if (Array.isArray(a) !== Array.isArray(b)) return false

  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((v, i) => isDeepEqual(v, b[i]))
  }

  const ao = a as Record<string, unknown>
  const bo = b as Record<string, unknown>
  const aKeys = Object.keys(ao)
  if (aKeys.length !== Object.keys(bo).length) return false
  return aKeys.every((k) => Object.hasOwn(bo, k) && isDeepEqual(ao[k], bo[k]))
}

/**
 * Compare the stored tools with a freshly extracted spec and work out the minimum
 * set of writes.
 *
 * - New operationId           → create.
 * - operationId still in spec → update only if a spec-derived field changed
 *   (name, description, method, path, input schema, or it was previously removed).
 *   A user edit is a field that differs from its spec baseline (`name != specName`);
 *   edited fields keep the user's value and only the baseline moves.
 * - operationId no longer in spec → markRemoved (soft delete; edits are kept).
 *
 * `enabled` and `hiddenParams` are user-owned and are never part of an update.
 */
export function mergeTools(existing: ExistingTool[], fresh: ToolDefinition[]): MergeResult {
  const freshById = new Map(fresh.map((t) => [t.operationId, t]))
  const existingIds = new Set(existing.map((t) => t.operationId))

  const update: ToolUpdate[] = []
  const markRemoved: string[] = []
  let unchanged = 0

  for (const ex of existing) {
    const f = freshById.get(ex.operationId)

    if (!f) {
      if (ex.removedAt === null) markRemoved.push(ex.operationId)
      else unchanged++
      continue
    }

    const specChanged =
      ex.specName !== f.name ||
      ex.specDescription !== f.description ||
      ex.method !== f.method ||
      ex.path !== f.path ||
      !isDeepEqual(ex.inputSchema, f.inputSchema) ||
      ex.removedAt !== null

    if (!specChanged) {
      unchanged++
      continue
    }

    const nameEdited = ex.name !== ex.specName
    const descriptionEdited = ex.description !== ex.specDescription

    update.push({
      operationId: f.operationId,
      method: f.method,
      path: f.path,
      name: nameEdited ? ex.name : f.name,
      description: descriptionEdited ? ex.description : f.description,
      specName: f.name,
      specDescription: f.description,
      inputSchema: f.inputSchema as JsonSchema,
    })
  }

  const create = fresh.filter((t) => !existingIds.has(t.operationId))

  return {
    create,
    update,
    markRemoved,
    added: create.length,
    updated: update.length,
    removed: markRemoved.length,
    unchanged,
  }
}
