'use server'
import { auth } from '@/auth'
import { db } from '@/lib/db'
import { z } from 'zod'
import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { validateUpstreamUrl } from '@/lib/upstream-url'

const SlugSchema = z
  .string()
  .regex(/^[a-z0-9-]{3,48}$/, 'Slug must be 3–48 lowercase letters, numbers, or hyphens')

const CreateProjectSchema = z.object({
  name: z.string().min(1, 'Name is required').max(100),
  slug: SlugSchema,
  upstreamBaseUrl: z.string().trim(),
})

export async function createProject(formData: FormData) {
  const session = await auth()
  if (!session?.user?.id) redirect('/sign-in')

  const raw = {
    name: formData.get('name'),
    slug: formData.get('slug'),
    upstreamBaseUrl: formData.get('upstreamBaseUrl') ?? '',
  }

  const parsed = CreateProjectSchema.safeParse(raw)
  if (!parsed.success) {
    return { error: parsed.error.issues.map((i) => i.message).join(', ') }
  }

  const { name, slug } = parsed.data

  const upstream = await validateUpstreamUrl(parsed.data.upstreamBaseUrl)
  if (!upstream.ok) return { error: `Upstream base URL: ${upstream.error}` }
  const upstreamBaseUrl = upstream.url

  const existing = await db.project.findUnique({ where: { slug } })
  if (existing) {
    return { error: 'A project with this slug already exists. Choose a different slug.' }
  }

  const project = await db.project.create({
    data: {
      userId: session.user.id,
      name,
      slug,
      upstreamBaseUrl,
    },
  })

  revalidatePath('/projects')
  redirect(`/projects/${project.slug}/overview`)
}

/** Deleting is irreversible, so the caller must echo the slug back; checked here, not just in the UI. */
export async function deleteProject(slug: string, confirmSlug: string) {
  const session = await auth()
  if (!session?.user?.id) redirect('/sign-in')

  if (confirmSlug !== slug) {
    return { error: 'Type the project slug exactly to confirm deletion.' }
  }

  const project = await db.project.findFirst({ where: { slug, userId: session.user.id } })
  if (!project) {
    return { error: 'Not found' }
  }

  await db.project.delete({ where: { id: project.id } })
  revalidatePath('/projects')
  redirect('/projects')
}

const UpdateSettingsSchema = z.object({
  name: z.string().trim().min(1, 'Name is required').max(100).optional(),
  upstreamBaseUrl: z.string().optional(),
})

/**
 * Partial update: a field that is omitted (undefined) is left exactly as stored.
 * Pass upstreamBaseUrl: '' to deliberately clear it.
 */
export async function updateProjectSettings(
  slug: string,
  data: { name?: string; upstreamBaseUrl?: string }
): Promise<{ error?: string; project?: { name: string; upstreamBaseUrl: string } }> {
  const session = await auth()
  if (!session?.user?.id) redirect('/sign-in')

  const project = await db.project.findFirst({ where: { slug, userId: session.user.id } })
  if (!project) {
    return { error: 'Not found' }
  }

  const parsed = UpdateSettingsSchema.safeParse(data)
  if (!parsed.success) {
    return { error: parsed.error.issues.map((i) => i.message).join(', ') }
  }

  const changes: { name?: string; upstreamBaseUrl?: string } = {}
  if (parsed.data.name !== undefined) changes.name = parsed.data.name

  if (parsed.data.upstreamBaseUrl !== undefined) {
    const upstream = await validateUpstreamUrl(parsed.data.upstreamBaseUrl)
    if (!upstream.ok) return { error: `Upstream base URL: ${upstream.error}` }
    changes.upstreamBaseUrl = upstream.url
  }

  const updated = await db.project.update({ where: { id: project.id }, data: changes })

  revalidatePath(`/projects/${slug}/settings`)
  revalidatePath(`/projects/${slug}/overview`)
  return { project: { name: updated.name, upstreamBaseUrl: updated.upstreamBaseUrl } }
}

/** Fetch current user's projects (server-side). */
export async function getProjects() {
  const session = await auth()
  if (!session?.user?.id) return []

  return db.project.findMany({
    where: { userId: session.user.id },
    orderBy: { createdAt: 'desc' },
    select: { id: true, name: true, slug: true, createdAt: true, upstreamBaseUrl: true },
  })
}

/** Fetch a single project owned by the current user. Returns null if not found or not owned. */
export async function getProject(slug: string) {
  const session = await auth()
  if (!session?.user?.id) return null

  return db.project.findFirst({
    where: { slug, userId: session.user.id },
  })
}
