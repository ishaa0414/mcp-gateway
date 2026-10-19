import { toAgentSchema } from '@mcp-gateway/openapi-tools'
import { db } from '@/lib/db'
import { buildFields, type PlaygroundField } from '@/lib/playground/fields'

/** A tool as the Playground page sends it to the browser. Nothing here comes from `hiddenParams`. */
export interface PlaygroundTool {
  id: string
  name: string
  description: string
  method: string
  path: string
  fields: PlaygroundField[]
}

/**
 * The enabled tools of a project the user owns, with their form fields, or `null` when the user does
 * not own a project with that slug. The fields come from the agent schema, which has the hidden
 * parameters removed, so neither their names nor their values can reach the browser.
 */
export async function playgroundTools(scope: { userId: string; slug: string }): Promise<PlaygroundTool[] | null> {
  const project = await db.project.findFirst({ where: { slug: scope.slug, userId: scope.userId }, select: { id: true } })
  if (!project) return null

  const tools = await db.tool.findMany({
    where: { projectId: project.id, enabled: true, removedAt: null },
    orderBy: { name: 'asc' },
    select: { id: true, name: true, description: true, method: true, path: true, inputSchema: true, hiddenParams: true },
  })

  return tools.map((t) => ({
    id: t.id,
    name: t.name,
    description: t.description,
    method: t.method.toUpperCase(),
    path: t.path,
    fields: buildFields(toAgentSchema(t.inputSchema as object, (t.hiddenParams ?? {}) as object)),
  }))
}
