/**
 * Project settings / delete actions against the test database. The session is
 * mocked; the action code, validation and Prisma queries are real.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { db } from '@mcp-gateway/db'

const session = vi.hoisted(() => ({ userId: '' }))

vi.mock('@/auth', () => ({ auth: async () => ({ user: { id: session.userId } }) }))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))
vi.mock('next/navigation', () => ({
  redirect: (url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`)
  },
}))

import { createProject, deleteProject, updateProjectSettings } from '@/actions/projects'

const PUBLIC_HOST = '93.184.216.34'
let slug: string
const users: string[] = []

beforeAll(async () => {
  const user = await db.user.create({ data: { email: `proj-${Date.now()}@test.local`, name: 'Owner' } })
  session.userId = user.id
  users.push(user.id)
})

afterAll(async () => {
  await db.user.deleteMany({ where: { id: { in: users } } })
})

beforeEach(async () => {
  slug = `settings-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
  await db.project.create({
    data: { userId: session.userId, name: 'Original', slug, upstreamBaseUrl: `https://${PUBLIC_HOST}/v1` },
  })
})

const stored = () => db.project.findFirstOrThrow({ where: { slug } })

describe('updateProjectSettings', () => {
  it('changing only the name leaves the base URL untouched', async () => {
    const res = await updateProjectSettings(slug, { name: 'Renamed' })

    expect(res.error).toBeUndefined()
    expect(await stored()).toMatchObject({ name: 'Renamed', upstreamBaseUrl: `https://${PUBLIC_HOST}/v1` })
  })

  it('changing only the base URL leaves the name untouched', async () => {
    await updateProjectSettings(slug, { upstreamBaseUrl: `https://${PUBLIC_HOST}/v2/` })

    expect(await stored()).toMatchObject({ name: 'Original', upstreamBaseUrl: `https://${PUBLIC_HOST}/v2` })
  })

  it('an explicit empty string clears the base URL; omitting it does not', async () => {
    await updateProjectSettings(slug, {})
    expect((await stored()).upstreamBaseUrl).toBe(`https://${PUBLIC_HOST}/v1`)

    await updateProjectSettings(slug, { upstreamBaseUrl: '' })
    expect((await stored()).upstreamBaseUrl).toBe('')
  })

  it.each(['/api/v3', 'api.example.com/v1', 'ftp://93.184.216.34', 'https://u:p@93.184.216.34'])(
    'rejects %s and stores nothing',
    async (bad) => {
      const res = await updateProjectSettings(slug, { name: 'Should not apply', upstreamBaseUrl: bad })

      expect(res.error).toMatch(/^Upstream base URL:/)
      expect(await stored()).toMatchObject({ name: 'Original', upstreamBaseUrl: `https://${PUBLIC_HOST}/v1` })
    }
  )

  it.each(['http://127.0.0.1:3000', 'http://169.254.169.254/latest', 'http://[::1]', 'http://localhost:8080'])(
    'SSRF-checks on save: rejects %s',
    async (bad) => {
      const res = await updateProjectSettings(slug, { upstreamBaseUrl: bad })
      expect(res.error).toMatch(/^Upstream base URL:/)
      expect((await stored()).upstreamBaseUrl).toBe(`https://${PUBLIC_HOST}/v1`)
    }
  )

  it('rejects an empty name', async () => {
    const res = await updateProjectSettings(slug, { name: '   ' })
    expect(res.error).toBeTruthy()
    expect((await stored()).name).toBe('Original')
  })
})

describe('createProject', () => {
  it('rejects a relative or private upstream URL', async () => {
    for (const bad of ['/api/v3', 'http://127.0.0.1']) {
      const fd = new FormData()
      fd.set('name', 'Bad')
      fd.set('slug', `bad-${Date.now()}`)
      fd.set('upstreamBaseUrl', bad)

      const res = await createProject(fd)

      expect(res).toMatchObject({ error: expect.stringContaining('Upstream base URL') })
    }
  })
})

describe('deleteProject', () => {
  it('refuses when the confirmation does not match the slug, and deletes nothing', async () => {
    for (const wrong of ['', 'nope', slug.toUpperCase(), `${slug} `]) {
      const res = await deleteProject(slug, wrong)
      expect(res).toMatchObject({ error: expect.stringContaining('slug') })
    }
    expect(await db.project.findFirst({ where: { slug } })).not.toBeNull()
  })

  it('deletes when the slug is typed exactly, then redirects', async () => {
    await expect(deleteProject(slug, slug)).rejects.toThrow('NEXT_REDIRECT:/projects')
    expect(await db.project.findFirst({ where: { slug } })).toBeNull()
  })

  it("will not delete another user's project even with the right slug", async () => {
    const other = await db.user.create({ data: { email: `other-${Date.now()}@test.local` } })
    users.push(other.id)
    const prev = session.userId
    session.userId = other.id
    try {
      expect(await deleteProject(slug, slug)).toEqual({ error: 'Not found' })
    } finally {
      session.userId = prev
    }
    expect(await db.project.findFirst({ where: { slug } })).not.toBeNull()
  })
})
