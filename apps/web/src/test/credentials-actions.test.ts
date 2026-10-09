import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { decrypt } from '@mcp-gateway/crypto'
import { db } from '@mcp-gateway/db'

const session = vi.hoisted(() => ({ userId: '' }))

vi.mock('@/auth', () => ({ auth: async () => (session.userId ? { user: { id: session.userId } } : null) }))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))

import { getCredentialSummary, updateCredential } from '@/actions/credentials'

const KEY = process.env['ENCRYPTION_KEY']!
const users: string[] = []
let owner: { id: string; slug: string; projectId: string }
let intruder: { id: string; slug: string; projectId: string }

async function makeUserWithProject(label: string) {
  const tag = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
  const user = await db.user.create({ data: { email: `${label}-${tag}@test.local`, name: label } })
  users.push(user.id)
  const slug = `cred-${label}-${tag}`
  const project = await db.project.create({ data: { userId: user.id, name: label, slug, upstreamBaseUrl: '' } })
  return { id: user.id, slug, projectId: project.id }
}

const stored = (projectId: string) => db.upstreamCredential.findUnique({ where: { projectId } })

beforeAll(async () => {
  owner = await makeUserWithProject('owner')
  intruder = await makeUserWithProject('intruder')
  session.userId = owner.id
})

afterAll(async () => {
  await db.user.deleteMany({ where: { id: { in: users } } })
})

describe('storing a credential', () => {
  it('encrypts a bearer token and never returns it', async () => {
    const res = await updateCredential(owner.slug, { type: 'BEARER', value: 'tok_live_SECRET_12345' })

    expect(res.error).toBeUndefined()
    expect(res.summary).toEqual({ type: 'BEARER', headerName: null, queryParamName: null, hasValue: true })
    expect(JSON.stringify(res)).not.toContain('SECRET_12345')

    const row = (await stored(owner.projectId))!
    expect(row.encryptedValue).not.toContain('SECRET_12345')
    expect(decrypt(row.encryptedValue!, KEY)).toBe('tok_live_SECRET_12345')
  })

  it('stores a custom header with its name', async () => {
    const res = await updateCredential(owner.slug, { type: 'CUSTOM_HEADER', headerName: 'X-Api-Key', value: 'hdr-secret' })

    expect(res.summary).toEqual({ type: 'CUSTOM_HEADER', headerName: 'X-Api-Key', queryParamName: null, hasValue: true })
    const row = (await stored(owner.projectId))!
    expect(decrypt(row.encryptedValue!, KEY)).toBe('hdr-secret')
    expect(row.queryParamName).toBeNull()
  })

  it('stores a query parameter credential with its name', async () => {
    const res = await updateCredential(owner.slug, { type: 'QUERY_PARAM', queryParamName: 'api_key', value: 'qry-secret' })

    expect(res.summary).toEqual({ type: 'QUERY_PARAM', headerName: null, queryParamName: 'api_key', hasValue: true })
    const row = (await stored(owner.projectId))!
    expect(row.headerName).toBeNull()
    expect(decrypt(row.encryptedValue!, KEY)).toBe('qry-secret')
  })

  it('encrypts the same value differently each time (random IV)', async () => {
    await updateCredential(owner.slug, { type: 'BEARER', value: 'same-value-1' })
    const first = (await stored(owner.projectId))!.encryptedValue
    await updateCredential(owner.slug, { type: 'BEARER', value: 'same-value-1' })
    expect((await stored(owner.projectId))!.encryptedValue).not.toBe(first)
  })
})

describe('the summary the browser gets', () => {
  it('says whether a value exists, never what it is', async () => {
    await updateCredential(owner.slug, { type: 'BEARER', value: 'hidden-from-browser-9' })

    const summary = await getCredentialSummary(owner.slug)

    expect(summary).toEqual({ type: 'BEARER', headerName: null, queryParamName: null, hasValue: true })
    expect(JSON.stringify(summary)).not.toContain('hidden-from-browser-9')
    expect(Object.keys(summary).sort()).toEqual(['hasValue', 'headerName', 'queryParamName', 'type'])
  })

  it('reports NONE when nothing is stored', async () => {
    const fresh = await makeUserWithProject('fresh')
    session.userId = fresh.id
    expect(await getCredentialSummary(fresh.slug)).toEqual({ type: 'NONE', headerName: null, queryParamName: null, hasValue: false })
    session.userId = owner.id
  })
})

describe('replacing and keeping the stored value', () => {
  it('keeps the secret when the value is left empty and the type is unchanged', async () => {
    await updateCredential(owner.slug, { type: 'CUSTOM_HEADER', headerName: 'X-Old', value: 'keep-me-123' })
    const before = (await stored(owner.projectId))!.encryptedValue

    const res = await updateCredential(owner.slug, { type: 'CUSTOM_HEADER', headerName: 'X-New', value: '' })

    expect(res.error).toBeUndefined()
    expect(res.summary?.headerName).toBe('X-New')
    const row = (await stored(owner.projectId))!
    expect(row.encryptedValue).toBe(before) // untouched
    expect(decrypt(row.encryptedValue!, KEY)).toBe('keep-me-123')
  })

  it('replaces the secret when a new value is given', async () => {
    await updateCredential(owner.slug, { type: 'BEARER', value: 'old-secret-1' })
    await updateCredential(owner.slug, { type: 'BEARER', value: 'new-secret-2' })
    expect(decrypt((await stored(owner.projectId))!.encryptedValue!, KEY)).toBe('new-secret-2')
  })

  it('never carries a secret over to a different kind of credential', async () => {
    await updateCredential(owner.slug, { type: 'BEARER', value: 'bearer-only-secret' })

    const res = await updateCredential(owner.slug, { type: 'QUERY_PARAM', queryParamName: 'token', value: '' })

    expect(res.error).toBe('Enter the credential value')
    const row = (await stored(owner.projectId))!
    expect(row.type).toBe('BEARER') // unchanged
    expect(decrypt(row.encryptedValue!, KEY)).toBe('bearer-only-secret')
  })

  it('requires a value the first time', async () => {
    const fresh = await makeUserWithProject('first')
    session.userId = fresh.id

    expect(await updateCredential(fresh.slug, { type: 'BEARER', value: '' })).toEqual({ error: 'Enter the credential value' })
    expect(await stored(fresh.projectId)).toBeNull()
    session.userId = owner.id
  })

  it('removes the credential, value included, when set to none', async () => {
    await updateCredential(owner.slug, { type: 'BEARER', value: 'to-be-removed-1' })

    const res = await updateCredential(owner.slug, { type: 'NONE' })

    expect(res.summary).toEqual({ type: 'NONE', headerName: null, queryParamName: null, hasValue: false })
    expect(await stored(owner.projectId)).toBeNull()
  })
})

describe('validation', () => {
  it.each([
    ['a line break in the value', { type: 'BEARER', value: 'a\r\nX-Evil: 1' }, /control characters/],
    ['a reserved header name', { type: 'CUSTOM_HEADER', headerName: 'Host', value: 'v' }, /set by the gateway/],
    ['a malformed header name', { type: 'CUSTOM_HEADER', headerName: 'bad name', value: 'v' }, /Header names/],
    ['a query name that would break the URL', { type: 'QUERY_PARAM', queryParamName: 'a&b=c', value: 'v' }, /letters, digits/],
    ['an unknown type', { type: 'BASIC', value: 'v' }, /./],
    ['no input at all', undefined, /./],
  ])('rejects %s and stores nothing new', async (_label, input, expected) => {
    await updateCredential(owner.slug, { type: 'BEARER', value: 'baseline-value-1' })
    const before = await stored(owner.projectId)

    const res = await updateCredential(owner.slug, input)

    expect(res.error).toMatch(expected)
    expect(await stored(owner.projectId)).toEqual(before)
  })
})

describe("one user cannot read or change another user's credential", () => {
  it('is refused for a project the user does not own', async () => {
    session.userId = owner.id
    await updateCredential(owner.slug, { type: 'BEARER', value: 'owners-secret-1' })

    session.userId = intruder.id
    expect(await updateCredential(owner.slug, { type: 'NONE' })).toEqual({ error: 'Project not found' })
    expect(await updateCredential(owner.slug, { type: 'BEARER', value: 'planted' })).toEqual({ error: 'Project not found' })
    expect(await getCredentialSummary(owner.slug)).toEqual({ type: 'NONE', headerName: null, queryParamName: null, hasValue: false })

    expect(decrypt((await stored(owner.projectId))!.encryptedValue!, KEY)).toBe('owners-secret-1')
    expect(await stored(intruder.projectId)).toBeNull()
    session.userId = owner.id
  })

  it('does nothing when nobody is signed in', async () => {
    session.userId = ''
    expect(await updateCredential(owner.slug, { type: 'NONE' })).toEqual({ error: 'Project not found' })
    session.userId = owner.id
    expect(await stored(owner.projectId)).not.toBeNull()
  })
})
