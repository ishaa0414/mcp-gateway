import { logEventSchema, type LogEvent } from '@mcp-gateway/shared/log-event'
import type { PrismaClient } from './generated/client/client.js'
import type { InputJsonValue } from './generated/client/internal/prismaNamespace.js'

export interface WriteLogResult {
  /** Rows actually inserted. */
  written: number
  /** Events whose id already existed (a redelivered batch): skipped, not an error. */
  duplicates: number
  /** Events that failed validation. */
  invalid: number
  /** Events whose project does not exist (any more, or no such slug). */
  unknownProject: number
}

/**
 * Write a batch of log events. Shared by the worker (queue mode) and the gateway (direct mode).
 *
 * - Each event is validated on its own, so one bad event does not sink the batch.
 * - An auth failure only knows the URL's slug; it is resolved to a project here, in one query,
 *   and dropped if no such project exists.
 * - A tool or key id is kept only if it belongs to the event's own project, and is nulled
 *   otherwise (a tool deleted since the call, or an id that was never this tenant's), so the
 *   foreign key cannot fail the whole batch and one tenant's row never points at another's.
 * - The row id is the event id, so inserting the same batch twice stores it once.
 */
export async function writeLogBatch(db: PrismaClient, rawEvents: readonly unknown[]): Promise<WriteLogResult> {
  const result: WriteLogResult = { written: 0, duplicates: 0, invalid: 0, unknownProject: 0 }

  const events: LogEvent[] = []
  for (const raw of rawEvents) {
    const parsed = logEventSchema.safeParse(raw)
    if (parsed.success) events.push(parsed.data)
    else result.invalid++
  }
  if (events.length === 0) return result

  const slugs = [...new Set(events.flatMap((e) => (e.projectId === undefined && e.projectSlug !== undefined ? [e.projectSlug] : [])))]
  const ids = [...new Set(events.flatMap((e) => (e.projectId !== undefined ? [e.projectId] : [])))]
  const projects = await db.project.findMany({
    where: { OR: [...(slugs.length ? [{ slug: { in: slugs } }] : []), ...(ids.length ? [{ id: { in: ids } }] : [])] },
    select: { id: true, slug: true },
  })
  const projectBySlug = new Map(projects.map((p) => [p.slug, p.id]))
  const projectIds = new Set(projects.map((p) => p.id))

  const toolIds = [...new Set(events.flatMap((e) => (e.toolId ? [e.toolId] : [])))]
  const keyIds = [...new Set(events.flatMap((e) => (e.apiKeyId ? [e.apiKeyId] : [])))]
  const [tools, keys] = await Promise.all([
    toolIds.length ? db.tool.findMany({ where: { id: { in: toolIds } }, select: { id: true, projectId: true } }) : [],
    keyIds.length ? db.apiKey.findMany({ where: { id: { in: keyIds } }, select: { id: true, projectId: true } }) : [],
  ])
  const toolProject = new Map(tools.map((t) => [t.id, t.projectId]))
  const keyProject = new Map(keys.map((k) => [k.id, k.projectId]))

  const rows = []
  for (const e of events) {
    const projectId = e.projectId ?? (e.projectSlug !== undefined ? projectBySlug.get(e.projectSlug) : undefined)
    if (projectId === undefined || !projectIds.has(projectId)) {
      result.unknownProject++
      continue
    }
    rows.push({
      id: e.id,
      kind: e.kind,
      projectId,
      toolId: e.toolId && toolProject.get(e.toolId) === projectId ? e.toolId : null,
      toolName: e.toolName,
      apiKeyId: e.apiKeyId && keyProject.get(e.apiKeyId) === projectId ? e.apiKeyId : null,
      input: e.input as InputJsonValue,
      upstreamStatus: e.upstreamStatus,
      latencyMs: e.latencyMs,
      success: e.success,
      errorClass: e.errorClass,
      errorMessage: e.errorMessage,
      responseBytes: e.responseBytes,
      createdAt: new Date(e.timestamp),
    })
  }
  if (rows.length === 0) return result

  const created = await db.toolCallLog.createMany({ data: rows, skipDuplicates: true })
  result.written = created.count
  result.duplicates = rows.length - created.count
  return result
}
