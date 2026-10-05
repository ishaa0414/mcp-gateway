'use server'
import { auth } from '@/auth'
import { db } from '@/lib/db'
import { revalidatePath } from 'next/cache'
import { parseSpec } from '@mcp-gateway/openapi-tools'
import { extractTools } from '@mcp-gateway/openapi-tools'
import { mergeTools } from '@mcp-gateway/openapi-tools'
import { ssrfFetch } from '@mcp-gateway/shared'
import type { ExistingTool } from '@mcp-gateway/openapi-tools'
import { createHash } from 'node:crypto'

const MAX_SPEC_BYTES = 5 * 1024 * 1024 // 5 MB

async function requireProject(slug: string) {
  const session = await auth()
  if (!session?.user?.id) throw new Error('Unauthenticated')

  const project = await db.project.findFirst({
    where: { slug, userId: session.user.id },
  })
  if (!project) throw new Error('Project not found')
  return project
}

async function processSpec(specText: string, projectSlug: string, projectId: string, isFirstImport: boolean) {
  const doc = await parseSpec(specText)
  const freshTools = extractTools(doc)

  const hash = createHash('sha256').update(specText).digest('hex')
  const specVersion = (doc as { info?: { version?: string } }).info?.version ?? '1.0.0'
  const serversUrl = freshTools[0]?.serversUrl

  // Fetch existing tools for merge
  const existingRows = await db.tool.findMany({ where: { projectId } })
  const existing: ExistingTool[] = existingRows.map((t) => ({
    operationId: t.operationId,
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema as Record<string, unknown>,
    enabled: t.enabled,
    hiddenParams: t.hiddenParams as Record<string, unknown>,
    removedAt: t.removedAt,
  }))

  const { tools, added, updated, removed } = mergeTools(existing, freshTools)

  // Transactionally update spec + tools
  await db.$transaction(async (tx) => {
    await tx.project.update({
      where: { id: projectId },
      data: {
        openapiSpec: doc as object,
        specHash: hash,
        specVersion,
        ...(isFirstImport && serversUrl && !existingRows.length
          ? { upstreamBaseUrl: serversUrl }
          : {}),
      },
    })

    for (const tool of tools) {
      const existingTool = existingRows.find((r) => r.operationId === tool.operationId)
      if (existingTool) {
        await tx.tool.update({
          where: { id: existingTool.id },
          data: {
            name: tool.name,
            description: tool.description,
            inputSchema: tool.inputSchema as object,
            removedAt: tool.removedAt,
          },
        })
      } else {
        await tx.tool.create({
          data: {
            projectId,
            operationId: tool.operationId,
            method: tool.method,
            path: tool.path,
            name: tool.name,
            description: tool.description,
            inputSchema: tool.inputSchema as object,
          },
        })
      }
    }
  })

  revalidatePath(`/projects/${projectSlug}/spec`)
  revalidatePath(`/projects/${projectSlug}/tools`)

  return { added, updated, removed, total: tools.length }
}

export async function importSpecFromFile(
  slug: string,
  formData: FormData
): Promise<{ error?: string; added?: number; updated?: number; removed?: number; total?: number }> {
  try {
    const project = await requireProject(slug)
    const file = formData.get('spec') as File | null
    if (!file) return { error: 'No file provided' }
    if (file.size > MAX_SPEC_BYTES) return { error: 'File too large (max 5 MB)' }

    const buf = Buffer.from(await file.arrayBuffer())
    const isFirst = !project.openapiSpec
    return await processSpec(buf.toString('utf-8'), slug, project.id, isFirst)
  } catch (e: unknown) {
    return { error: e instanceof Error ? e.message : 'Import failed' }
  }
}

export async function importSpecFromUrl(
  slug: string,
  url: string
): Promise<{ error?: string; added?: number; updated?: number; removed?: number; total?: number }> {
  try {
    const project = await requireProject(slug)

    let response
    try {
      response = await ssrfFetch(url)
    } catch (e: unknown) {
      return { error: `Failed to fetch spec: ${e instanceof Error ? e.message : String(e)}` }
    }

    if (response.status !== 200) {
      return { error: `Server returned ${response.status}` }
    }
    if (response.body.length > MAX_SPEC_BYTES) {
      return { error: 'Spec too large (max 5 MB)' }
    }

    const isFirst = !project.openapiSpec
    return await processSpec(response.text(), slug, project.id, isFirst)
  } catch (e: unknown) {
    return { error: e instanceof Error ? e.message : 'Import failed' }
  }
}
