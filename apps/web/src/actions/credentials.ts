'use server'
import { auth } from '@/auth'
import { CredentialInputSchema } from '@/lib/credential-input'
import { db } from '@/lib/db'
import { encryptionKey } from '@/lib/encryption-key'
import { cacheInvalidator } from '@/lib/redis'
import { encrypt } from '@mcp-gateway/crypto'
import { revalidatePath } from 'next/cache'

/**
 * What the browser may know about a stored credential. The value itself is deliberately not a
 * field here: once saved it is never sent back, only replaced.
 */
export interface CredentialSummary {
  type: 'NONE' | 'BEARER' | 'CUSTOM_HEADER' | 'QUERY_PARAM'
  headerName: string | null
  queryParamName: string | null
  hasValue: boolean
}

const NONE: CredentialSummary = { type: 'NONE', headerName: null, queryParamName: null, hasValue: false }

async function ownedProject(slug: string) {
  const session = await auth()
  if (!session?.user?.id) return null
  return db.project.findFirst({ where: { slug, userId: session.user.id }, select: { id: true } })
}

function summarize(row: { type: CredentialSummary['type']; headerName: string | null; queryParamName: string | null; encryptedValue: string | null } | null): CredentialSummary {
  if (!row) return NONE
  return { type: row.type, headerName: row.headerName, queryParamName: row.queryParamName, hasValue: row.encryptedValue !== null }
}

export async function getCredentialSummary(slug: string): Promise<CredentialSummary> {
  const project = await ownedProject(slug)
  if (!project) return NONE
  return summarize(await db.upstreamCredential.findUnique({ where: { projectId: project.id } }))
}

export async function updateCredential(
  slug: string,
  input: unknown
): Promise<{ error?: string; summary?: CredentialSummary }> {
  const project = await ownedProject(slug)
  if (!project) return { error: 'Project not found' }

  const parsed = CredentialInputSchema.safeParse(input)
  if (!parsed.success) return { error: parsed.error.issues.map((i) => i.message).join(', ') }
  const data = parsed.data

  if (data.type === 'NONE') {
    await db.upstreamCredential.deleteMany({ where: { projectId: project.id } })
    await cacheInvalidator.project(slug)
    revalidatePath(`/projects/${slug}/settings`)
    return { summary: NONE }
  }

  const existing = await db.upstreamCredential.findUnique({ where: { projectId: project.id } })

  // An empty value means "keep the stored secret", but only for the same kind of credential:
  // a secret is never carried over to a different scheme, which could send it somewhere it was
  // not meant for.
  const keepExisting = data.value === undefined && existing?.type === data.type && existing.encryptedValue !== null
  if (data.value === undefined && !keepExisting) return { error: 'Enter the credential value' }

  const fields = {
    type: data.type,
    headerName: data.type === 'CUSTOM_HEADER' ? data.headerName : null,
    queryParamName: data.type === 'QUERY_PARAM' ? data.queryParamName : null,
    ...(data.value !== undefined ? { encryptedValue: encrypt(data.value, encryptionKey()) } : {}),
  }

  const saved = await db.upstreamCredential.upsert({
    where: { projectId: project.id },
    create: { projectId: project.id, ...fields },
    update: fields,
  })

  await cacheInvalidator.project(slug)
  revalidatePath(`/projects/${slug}/settings`)
  return { summary: summarize(saved) }
}
