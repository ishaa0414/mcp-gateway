'use server'
import { auth } from '@/auth'
import { db } from '@/lib/db'
import { cacheInvalidator } from '@/lib/redis'
import { revalidatePath } from 'next/cache'
import { ssrfFetch } from '@mcp-gateway/shared'
import { importSpec, type ImportResult } from '@/lib/spec-import'

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

async function runImport(slug: string, projectId: string, specText: string, specUrl?: string): Promise<ImportResult> {
  const summary = await importSpec(db, { projectId, specText, specUrl })
  await cacheInvalidator.project(slug)

  revalidatePath(`/projects/${slug}/overview`)
  revalidatePath(`/projects/${slug}/spec`)
  revalidatePath(`/projects/${slug}/tools`)
  revalidatePath(`/projects/${slug}/settings`)
  return summary
}

export async function importSpecFromFile(slug: string, formData: FormData): Promise<ImportResult> {
  try {
    const project = await requireProject(slug)
    const file = formData.get('spec') as File | null
    if (!file) return { error: 'No file provided' }
    if (file.size > MAX_SPEC_BYTES) return { error: 'File too large (max 5 MB)' }

    const text = Buffer.from(await file.arrayBuffer()).toString('utf-8')
    return await runImport(slug, project.id, text)
  } catch (e: unknown) {
    return { error: e instanceof Error ? e.message : 'Import failed' }
  }
}

export async function importSpecFromUrl(slug: string, url: string): Promise<ImportResult> {
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

    return await runImport(slug, project.id, response.text(), url)
  } catch (e: unknown) {
    return { error: e instanceof Error ? e.message : 'Import failed' }
  }
}
