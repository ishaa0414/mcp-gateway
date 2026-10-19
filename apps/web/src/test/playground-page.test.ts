/**
 * What the Playground page sends to the browser: only the owner's enabled tools, and nothing that
 * comes from a hidden parameter. Real database; the session and environment are stubbed.
 */
import { db } from '@mcp-gateway/db'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

const session = vi.hoisted(() => ({ userId: '' }))
const settings = vi.hoisted(() => ({ value: {} as Record<string, unknown> }))

vi.mock('@/auth', () => ({ auth: async () => (session.userId ? { user: { id: session.userId } } : null) }))
vi.mock('@/lib/env', async (importOriginal) => ({ ...(await importOriginal<typeof import('@/lib/env')>()), env: () => settings.value }))
vi.mock('next/navigation', () => ({
  notFound: () => {
    throw new Error('NEXT_NOT_FOUND')
  },
}))

import PlaygroundPage from '@/app/(dashboard)/projects/[slug]/playground/page'
import { playgroundTools } from '@/lib/playground/tools'

const HIDDEN_VALUE = 'hidden-fixed-value-5521'
const HIDDEN_NAME = 'tenantSecretParam'
const HIDDEN_ENUM_VALUE = 'hidden-enum-choice-7788'

const users: string[] = []
let ownerId: string
let otherId: string
let slug: string
let otherSlug: string
let emptySlug: string
let credentialSlug: string
let nullHiddenId: string
let hiddenOnlySlug: string

const schema = {
  type: 'object',
  required: ['petId', HIDDEN_NAME],
  properties: {
    petId: { type: 'integer' },
    [HIDDEN_NAME]: { type: 'string', description: `fixed to ${HIDDEN_VALUE}`, enum: [HIDDEN_ENUM_VALUE, HIDDEN_VALUE] },
    note: { type: 'string' },
  },
}

async function makeProject(userId: string, label: string) {
  return db.project.create({
    data: { userId, name: label, slug: `pgpage-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, upstreamBaseUrl: 'https://api.example.com' },
  })
}

const addTool = (projectId: string, name: string, extra: Record<string, unknown> = {}) =>
  db.tool.create({
    data: { projectId, operationId: `op_${name}`, method: 'GET', path: `/${name}`, name, description: 'd', specName: name, specDescription: 'd', inputSchema: schema, ...extra },
  })

beforeAll(async () => {
  const owner = await db.user.create({ data: { email: `pgpage-owner-${Date.now()}@test.local`, name: 'Owner' } })
  const other = await db.user.create({ data: { email: `pgpage-other-${Date.now()}@test.local`, name: 'Other' } })
  users.push(owner.id, other.id)
  ownerId = owner.id
  otherId = other.id
  session.userId = owner.id

  const mine = await makeProject(owner.id, 'mine')
  slug = mine.slug
  await addTool(mine.id, 'withHidden', { hiddenParams: { [HIDDEN_NAME]: { value: HIDDEN_VALUE } } })
  await addTool(mine.id, 'plain')
  await addTool(mine.id, 'off', { enabled: false })
  await addTool(mine.id, 'gone', { removedAt: new Date() })

  const theirs = await makeProject(other.id, 'theirs')
  otherSlug = theirs.slug
  await addTool(theirs.id, 'theirTool')

  emptySlug = (await makeProject(owner.id, 'empty')).slug

  const withCredential = await makeProject(owner.id, 'withcred')
  credentialSlug = withCredential.slug
  await addTool(withCredential.id, 'plain')
  await db.upstreamCredential.create({ data: { projectId: withCredential.id, type: 'BEARER', encryptedValue: 'not-a-real-ciphertext' } })

  const nullHidden = await makeProject(owner.id, 'nullhidden')
  await addTool(nullHidden.id, 'neverSent', { hiddenParams: { note: { value: null, required: false } } })
  nullHiddenId = nullHidden.id

  const hiddenOnly = await makeProject(owner.id, 'hiddenonly')
  hiddenOnlySlug = hiddenOnly.slug
  await addTool(hiddenOnly.id, 'withHidden', { hiddenParams: { [HIDDEN_NAME]: { value: HIDDEN_VALUE } } })
})

afterAll(async () => {
  await db.user.deleteMany({ where: { id: { in: users } } })
})

describe('playgroundTools', () => {
  it("lists only the owner's enabled, non-removed tools, with method and path", async () => {
    const tools = await playgroundTools({ userId: ownerId, slug })
    expect(tools?.map((t) => t.name)).toEqual(['plain', 'withHidden'])
    expect(tools?.[0]).toMatchObject({ method: 'GET', path: '/plain' })
  })

  it('is null for a project the user does not own, the same as for one that does not exist', async () => {
    expect(await playgroundTools({ userId: ownerId, slug: otherSlug })).toBeNull()
    expect(await playgroundTools({ userId: otherId, slug })).toBeNull()
    expect(await playgroundTools({ userId: ownerId, slug: 'no-such-project' })).toBeNull()
  })

  it('has no field for a hidden parameter, so its name and value are not in what the browser gets', async () => {
    const tools = await playgroundTools({ userId: ownerId, slug })
    const withHidden = tools!.find((t) => t.name === 'withHidden')!
    expect(withHidden.fields.map((f) => f.name)).toEqual(['petId', 'note'])
    const payload = JSON.stringify(withHidden)
    for (const secret of [HIDDEN_NAME, HIDDEN_VALUE, HIDDEN_ENUM_VALUE]) expect(payload).not.toContain(secret)
  })

  it('says whether a hidden value is sent: yes for a fixed value, no for none and for "never send" (null)', async () => {
    const tools = (await playgroundTools({ userId: ownerId, slug }))!
    expect(tools.find((t) => t.name === 'withHidden')!.hasHidden).toBe(true)
    expect(tools.find((t) => t.name === 'plain')!.hasHidden).toBe(false)
    const neverSent = await db.project.findUniqueOrThrow({ where: { id: nullHiddenId }, select: { slug: true } })
    expect((await playgroundTools({ userId: ownerId, slug: neverSent.slug }))![0]!.hasHidden).toBe(false)
  })

  it('the same tool without a hidden parameter does show it (so the check above means something)', async () => {
    const plain = (await playgroundTools({ userId: ownerId, slug }))!.find((t) => t.name === 'plain')!
    expect(plain.fields.map((f) => f.name)).toEqual(['petId', HIDDEN_NAME, 'note'])
  })
})

describe('the page', () => {
  const render = (s: string) => PlaygroundPage({ params: Promise.resolve({ slug: s }) })
  // Everything the page element holds, including the props handed to client components. React elements can be cyclic.
  const serialise = (node: unknown) => {
    const seen = new WeakSet<object>()
    return JSON.stringify(node, (_key, value) => {
      if (typeof value === 'object' && value !== null) {
        if (seen.has(value)) return undefined
        seen.add(value)
      }
      return typeof value === 'bigint' ? String(value) : value
    })
  }

  it("passes the browser the tools without any hidden parameter's name or value", async () => {
    settings.value = { PLAYGROUND_SECRET: 'x'.repeat(40) }
    const payload = serialise(await render(hiddenOnlySlug))
    expect(payload).toContain('withHidden') // the tool is there
    for (const secret of [HIDDEN_NAME, HIDDEN_VALUE, HIDDEN_ENUM_VALUE]) expect(payload).not.toContain(secret)
  })

  it('tells the browser only whether a credential exists, never its type or value', async () => {
    settings.value = { PLAYGROUND_SECRET: 'x'.repeat(40) }
    const withCredential = serialise(await render(credentialSlug))
    expect(withCredential).toContain('"hasCredential":true')
    expect(withCredential).not.toMatch(/BEARER|not-a-real-ciphertext/)
    expect(serialise(await render(hiddenOnlySlug))).toContain('"hasCredential":false')
  })

  it('is a not-found for a project the user does not own', async () => {
    settings.value = { PLAYGROUND_SECRET: 'x'.repeat(40) }
    await expect(render(otherSlug)).rejects.toThrow('NEXT_NOT_FOUND')
    await expect(render('no-such-project')).rejects.toThrow('NEXT_NOT_FOUND')
  })

  it('explains the missing secret instead of listing tools, and sends no tool data', async () => {
    settings.value = {}
    const payload = serialise(await render(slug))
    expect(payload).toContain('Playground not configured')
    expect(payload).toContain('PLAYGROUND_SECRET')
    expect(payload).not.toContain('withHidden')
  })

  it('points to the Tools tab when no tool is enabled', async () => {
    settings.value = { PLAYGROUND_SECRET: 'x'.repeat(40) }
    const payload = serialise(await render(emptySlug))
    expect(payload).toContain('No enabled tools')
    expect(payload).toContain(`/projects/${emptySlug}/tools`)
  })
})
