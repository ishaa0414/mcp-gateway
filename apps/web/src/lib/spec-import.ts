import { createHash } from 'node:crypto'
import type { PrismaClient } from '@mcp-gateway/db'
import { extractTools, mergeTools, parseSpec, resolveBaseUrl } from '@mcp-gateway/openapi-tools'
import type { ExistingTool, NameCollision } from '@mcp-gateway/openapi-tools'
import { isAbsoluteHttpUrl, validateUpstreamUrl } from '@/lib/upstream-url'

/** What happened to the project's upstream base URL during an import. */
export type BaseUrlOutcome =
  | { status: 'set'; url: string }
  | { status: 'kept'; url: string }
  | { status: 'unset'; reason: 'relative' | 'none' | 'rejected'; detail?: string }

export interface ImportSummary {
  added: number
  updated: number
  removed: number
  unchanged: number
  /** Active operations in the imported spec. */
  total: number
  /** Spec names that were already taken by another tool, so the tool got a suffixed name. */
  collisions: NameCollision[]
  baseUrl: BaseUrlOutcome
}

export type ImportResult = ImportSummary | { error: string }

interface ImportInput {
  projectId: string
  specText: string
  /** Set when the spec was fetched from a URL; used to resolve a relative servers[0].url. */
  specUrl?: string
}

async function chooseBaseUrl(
  current: string,
  doc: Record<string, unknown>,
  specUrl: string | undefined
): Promise<BaseUrlOutcome> {
  // Never overwrite a value the user (or an earlier import) already set.
  if (isAbsoluteHttpUrl(current)) return { status: 'kept', url: current }

  const resolved = resolveBaseUrl(doc, specUrl)
  if (resolved.status === 'none') return { status: 'unset', reason: 'none' }
  if (resolved.status === 'relative') return { status: 'unset', reason: 'relative' }
  if (resolved.status === 'invalid') {
    return { status: 'unset', reason: 'rejected', detail: `${resolved.raw}: ${resolved.reason}` }
  }

  const checked = await validateUpstreamUrl(resolved.url)
  if (!checked.ok) {
    return { status: 'unset', reason: 'rejected', detail: `${resolved.url}: ${checked.error}` }
  }
  return { status: 'set', url: checked.url }
}

/**
 * Import (or re-import) an OpenAPI spec into a project.
 *
 * Only spec-derived data is written. A tool's name/description are overwritten
 * only while they still equal what the spec last produced, and `enabled` and
 * `hiddenParams` are never touched, so edits survive re-imports.
 */
export async function importSpec(db: PrismaClient, input: ImportInput): Promise<ImportSummary> {
  const { projectId, specText, specUrl } = input

  const doc = await parseSpec(specText)
  const fresh = extractTools(doc)

  const project = await db.project.findUniqueOrThrow({ where: { id: projectId } })
  const baseUrl = await chooseBaseUrl(project.upstreamBaseUrl, doc, specUrl)

  const rows = await db.tool.findMany({ where: { projectId } })
  const existing: ExistingTool[] = rows.map((t) => ({
    operationId: t.operationId,
    method: t.method,
    path: t.path,
    name: t.name,
    description: t.description,
    specName: t.specName,
    specDescription: t.specDescription,
    inputSchema: t.inputSchema as Record<string, unknown>,
    removedAt: t.removedAt,
  }))
  const rowsByOperation = new Map(rows.map((r) => [r.operationId, r]))

  const merge = mergeTools(existing, fresh)

  await db.$transaction(async (tx) => {
    await tx.project.update({
      where: { id: projectId },
      data: {
        openapiSpec: doc as object,
        specHash: createHash('sha256').update(specText).digest('hex'),
        specVersion: (doc as { info?: { version?: string } }).info?.version ?? '1.0.0',
        ...(baseUrl.status === 'set' ? { upstreamBaseUrl: baseUrl.url } : {}),
      },
    })

    // The unique (project, name) index is checked per statement, so tools that swap
    // or hand over names would clash mid-way. Park every tool whose name changes on a
    // placeholder first, then write the final values.
    const renamed = merge.update
      .map((u) => ({ u, row: rowsByOperation.get(u.operationId)! }))
      .filter(({ u, row }) => u.name !== row.name)
    for (const { row } of renamed) {
      await tx.tool.update({ where: { id: row.id }, data: { name: `~${row.id}` } })
    }

    for (const u of merge.update) {
      await tx.tool.update({
        where: { id: rowsByOperation.get(u.operationId)!.id },
        data: {
          method: u.method,
          path: u.path,
          name: u.name,
          description: u.description,
          specName: u.specName,
          specDescription: u.specDescription,
          inputSchema: u.inputSchema as object,
          removedAt: null,
        },
      })
    }

    if (merge.create.length > 0) {
      await tx.tool.createMany({
        data: merge.create.map((t) => ({
          projectId,
          operationId: t.operationId,
          method: t.method,
          path: t.path,
          name: t.name,
          description: t.description,
          specName: t.specName,
          specDescription: t.specDescription,
          inputSchema: t.inputSchema as object,
        })),
      })
    }

    if (merge.markRemoved.length > 0) {
      await tx.tool.updateMany({
        where: { projectId, operationId: { in: merge.markRemoved } },
        data: { removedAt: new Date() },
      })
    }
  })

  return {
    added: merge.added,
    updated: merge.updated,
    removed: merge.removed,
    unchanged: merge.unchanged,
    total: fresh.length,
    collisions: merge.collisions,
    baseUrl,
  }
}
