'use server'
import { auth } from '@/auth'
import { db } from '@/lib/db'
import { cacheInvalidator } from '@/lib/redis'
import { revalidatePath } from 'next/cache'
import { toolNameTakenMessage, validateToolName } from '@mcp-gateway/openapi-tools'


async function requireToolOwner(toolId: string) {
  const session = await auth()
  if (!session?.user?.id) throw new Error('Unauthenticated')

  const tool = await db.tool.findUnique({
    where: { id: toolId },
    include: { project: { select: { userId: true, slug: true } } },
  })
  if (!tool || tool.project.userId !== session.user.id) throw new Error('Not found')
  return tool
}

export async function updateToolEnabled(
  toolId: string,
  enabled: boolean
): Promise<{ error?: string }> {
  try {
    const tool = await requireToolOwner(toolId)
    await db.tool.update({ where: { id: toolId }, data: { enabled } })
    await cacheInvalidator.project(tool.project.slug)
    revalidatePath(`/projects/${tool.project.slug}/tools`)
    return {}
  } catch (e: unknown) {
    return { error: e instanceof Error ? e.message : 'Failed' }
  }
}

export async function updateTool(
  toolId: string,
  data: {
    name?: string
    description?: string
    hiddenParams?: Record<string, { value: unknown; required?: boolean }>
  }
): Promise<{ error?: string; field?: 'name' }> {
  try {
    const tool = await requireToolOwner(toolId)

    if (data.name !== undefined) {
      const validation = validateToolName(data.name)
      if (!validation.valid) return { error: validation.error, field: 'name' }

      // Ensure unique within project
      const conflict = await db.tool.findFirst({
        where: { projectId: tool.projectId, name: data.name, id: { not: toolId } },
      })
      if (conflict) return { error: toolNameTakenMessage(data.name), field: 'name' }
    }

    // Validate hidden params: required params must have a fixed value
    if (data.hiddenParams) {
      const inputSchema = tool.inputSchema as {
        required?: string[]
        properties?: Record<string, unknown>
      }
      const requiredFields = inputSchema.required ?? []
      for (const [paramName, cfg] of Object.entries(data.hiddenParams)) {
        if (requiredFields.includes(paramName) && (cfg.value === undefined || cfg.value === null || cfg.value === '')) {
          return {
            error: `Hidden required param "${paramName}" must have a fixed value`,
          }
        }
      }
    }

    await db.tool.update({
      where: { id: toolId },
      data: {
        ...(data.name !== undefined ? { name: data.name } : {}),
        ...(data.description !== undefined ? { description: data.description } : {}),
        ...(data.hiddenParams !== undefined ? { hiddenParams: data.hiddenParams as object } : {}),
      },
    })

    await cacheInvalidator.project(tool.project.slug)
    revalidatePath(`/projects/${tool.project.slug}/tools`)
    return {}
  } catch (e: unknown) {
    // Lost a race with another rename: the unique (project, name) index has the final word.
    if (data.name !== undefined && typeof e === 'object' && e !== null && 'code' in e && e.code === 'P2002') {
      return { error: toolNameTakenMessage(data.name), field: 'name' }
    }
    return { error: e instanceof Error ? e.message : 'Failed' }
  }
}

export async function getTools(slug: string) {
  const session = await auth()
  if (!session?.user?.id) return []

  const project = await db.project.findFirst({
    where: { slug, userId: session.user.id },
  })
  if (!project) return []

  return db.tool.findMany({
    where: { projectId: project.id },
    orderBy: [{ removedAt: 'asc' }, { name: 'asc' }],
  })
}
