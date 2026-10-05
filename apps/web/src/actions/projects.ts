'use server'
import { auth } from '@/auth'
import { db } from '@/lib/db'
import { z } from 'zod'
import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'

const SlugSchema = z
  .string()
  .regex(/^[a-z0-9-]{3,48}$/, 'Slug must be 3–48 lowercase letters, numbers, or hyphens')

const CreateProjectSchema = z.object({
  name: z.string().min(1, 'Name is required').max(100),
  slug: SlugSchema,
  upstreamBaseUrl: z.string().url('Must be a valid URL').or(z.literal('')),
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

  const { name, slug, upstreamBaseUrl } = parsed.data

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

export async function deleteProject(slug: string) {
  const session = await auth()
  if (!session?.user?.id) redirect('/sign-in')

  const project = await db.project.findFirst({ where: { slug, userId: session.user.id } })
  if (!project) {
    return { error: 'Not found' }
  }

  await db.project.delete({ where: { id: project.id } })
  revalidatePath('/projects')
  redirect('/projects')
}

export async function updateProjectSettings(
  slug: string,
  data: { name?: string; upstreamBaseUrl?: string }
) {
  const session = await auth()
  if (!session?.user?.id) redirect('/sign-in')

  const project = await db.project.findFirst({ where: { slug, userId: session.user.id } })
  if (!project) {
    return { error: 'Not found' }
  }

  const schema = z.object({
    name: z.string().min(1).max(100).optional(),
    upstreamBaseUrl: z.string().url().or(z.literal('')).optional(),
  })

  const parsed = schema.safeParse(data)
  if (!parsed.success) {
    return { error: parsed.error.issues.map((i) => i.message).join(', ') }
  }

  await db.project.update({
    where: { id: project.id },
    data: parsed.data,
  })

  revalidatePath(`/projects/${slug}/settings`)
  return { success: true }
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
