'use server'
import { auth } from '@/auth'
import { db } from '@/lib/db'
import { cacheInvalidator } from '@/lib/redis'
import { generateApiKey } from '@mcp-gateway/crypto'
import { revalidatePath } from 'next/cache'
import { z } from 'zod'

export interface ApiKeySummary {
  id: string
  name: string
  prefix: string
  rateLimitPerMin: number
  createdAt: string
  lastUsedAt: string | null
  revokedAt: string | null
}

const CreateKeySchema = z.object({
  name: z.string().trim().min(1, 'Give the key a name').max(60, 'Use at most 60 characters'),
  rateLimitPerMin: z.coerce
    .number({ error: 'Enter a number' })
    .int('Use a whole number')
    .min(1, 'At least 1 request per minute')
    .max(10_000, 'At most 10,000 requests per minute'),
})

/** The project, only if it belongs to the signed-in user. Every query below goes through this. */
async function ownedProject(slug: string) {
  const session = await auth()
  if (!session?.user?.id) return null
  return db.project.findFirst({ where: { slug, userId: session.user.id }, select: { id: true } })
}

const toSummary = (k: {
  id: string
  name: string
  prefix: string
  rateLimitPerMin: number
  createdAt: Date
  lastUsedAt: Date | null
  revokedAt: Date | null
}): ApiKeySummary => ({
  id: k.id,
  name: k.name,
  prefix: k.prefix,
  rateLimitPerMin: k.rateLimitPerMin,
  createdAt: k.createdAt.toISOString(),
  lastUsedAt: k.lastUsedAt?.toISOString() ?? null,
  revokedAt: k.revokedAt?.toISOString() ?? null,
})

export async function listApiKeys(slug: string): Promise<ApiKeySummary[]> {
  const project = await ownedProject(slug)
  if (!project) return []

  const keys = await db.apiKey.findMany({
    where: { projectId: project.id },
    orderBy: { createdAt: 'desc' },
    // Never select the hash: it is not needed here and must not reach the browser.
    select: { id: true, name: true, prefix: true, rateLimitPerMin: true, createdAt: true, lastUsedAt: true, revokedAt: true },
  })
  return keys.map(toSummary)
}

/**
 * Create a key. The full key is returned in this response only: just its SHA-256 hash is
 * stored, so it cannot be shown again.
 */
export async function createApiKey(
  slug: string,
  input: { name: string; rateLimitPerMin: number | string }
): Promise<{ error?: string; key?: string; apiKey?: ApiKeySummary }> {
  const project = await ownedProject(slug)
  if (!project) return { error: 'Project not found' }

  const parsed = CreateKeySchema.safeParse(input)
  if (!parsed.success) return { error: parsed.error.issues.map((i) => i.message).join(', ') }

  const generated = generateApiKey()
  const row = await db.apiKey.create({
    data: {
      projectId: project.id,
      name: parsed.data.name,
      prefix: generated.prefix,
      hash: generated.hash,
      rateLimitPerMin: parsed.data.rateLimitPerMin,
    },
  })

  revalidatePath(`/projects/${slug}/api-keys`)
  return { key: generated.key, apiKey: toSummary(row) }
}

export async function revokeApiKey(slug: string, keyId: string): Promise<{ error?: string }> {
  const project = await ownedProject(slug)
  if (!project) return { error: 'Project not found' }

  // Scoped to the project, so another project's key id (or a guessed one) matches nothing.
  const key = await db.apiKey.findFirst({ where: { id: keyId, projectId: project.id }, select: { id: true, hash: true, revokedAt: true } })
  if (!key) return { error: 'Key not found' }

  if (!key.revokedAt) {
    await db.apiKey.update({ where: { id: key.id }, data: { revokedAt: new Date() } })
  }
  // Even for an already-revoked key: harmless, and it repairs a missed invalidation.
  await cacheInvalidator.apiKey(key.hash)

  revalidatePath(`/projects/${slug}/api-keys`)
  return {}
}
