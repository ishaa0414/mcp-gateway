import type { JsonSchema, MergeResult, NameCollision, ToolDefinition, ToolWrite } from './types.js'

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

const MAX_NAME_LENGTH = 64

/** Return `name`, or `name_2`, `name_3`, … (kept within 64 chars) — the first one not in `used`; marks it used. */
function takeUniqueName(name: string, used: Set<string>): string {
  let candidate = name
  for (let n = 2; used.has(candidate); n++) {
    const suffix = `_${n}`
    candidate = name.slice(0, MAX_NAME_LENGTH - suffix.length) + suffix
  }
  used.add(candidate)
  return candidate
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
 * Names must be unique within a project. Names a tool already holds (user-chosen,
 * unchanged, or belonging to a removed tool) are reserved first, so a user's name
 * always wins. A spec-derived name that is then already taken gets `_2`, `_3`, …
 * and is reported in `collisions`.
 *
 * `enabled` and `hiddenParams` are user-owned and are never part of an update.
 */
export function mergeTools(existing: ExistingTool[], fresh: ToolDefinition[]): MergeResult {
  const freshById = new Map(fresh.map((t) => [t.operationId, t]))
  const existingIds = new Set(existing.map((t) => t.operationId))

  const markRemoved: string[] = []
  let unchanged = 0

  // Names that stay exactly as they are.
  const used = new Set<string>()
  // Existing tools whose name is about to follow the spec; they are named after the reserved ones.
  const movers: Array<{ ex: ExistingTool; f: ToolDefinition }> = []
  const changed: Array<{ ex: ExistingTool; f: ToolDefinition; nameEdited: boolean }> = []

  for (const ex of existing) {
    const f = freshById.get(ex.operationId)

    if (!f) {
      used.add(ex.name)
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
      used.add(ex.name)
      unchanged++
      continue
    }

    const nameEdited = ex.name !== ex.specName
    changed.push({ ex, f, nameEdited })
    if (nameEdited) used.add(ex.name)
    else movers.push({ ex, f })
  }

  const collisions: NameCollision[] = []
  const assign = (operationId: string, wanted: string): string => {
    const assigned = takeUniqueName(wanted, used)
    if (assigned !== wanted) collisions.push({ operationId, wanted, assigned })
    return assigned
  }

  const moverNames = new Map(movers.map(({ f }) => [f.operationId, assign(f.operationId, f.name)]))

  const update: ToolWrite[] = changed.map(({ ex, f, nameEdited }) => ({
    operationId: f.operationId,
    method: f.method,
    path: f.path,
    name: nameEdited ? ex.name : moverNames.get(f.operationId)!,
    description: ex.description !== ex.specDescription ? ex.description : f.description,
    specName: f.name,
    specDescription: f.description,
    inputSchema: f.inputSchema as JsonSchema,
  }))

  const create: ToolWrite[] = fresh
    .filter((t) => !existingIds.has(t.operationId))
    .map((t) => ({
      ...t,
      name: assign(t.operationId, t.name),
      specName: t.name,
      specDescription: t.description,
    }))

  return {
    create,
    update,
    markRemoved,
    collisions,
    added: create.length,
    updated: update.length,
    removed: markRemoved.length,
    unchanged,
  }
}
