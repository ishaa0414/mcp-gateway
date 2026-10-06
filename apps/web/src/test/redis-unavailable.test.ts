/**
 * With Redis unreachable, dashboard actions must still succeed (the edit is already in Postgres)
 * and must not make the user wait: Redis is only a cache the gateway can do without.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { db } from '@mcp-gateway/db'

const session = vi.hoisted(() => ({ userId: '' }))

vi.mock('@/auth', () => ({ auth: async () => ({ user: { id: session.userId } }) }))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))

const users: string[] = []
let slug: string
let projectId: string
let toolId: string
let actions: {
  tools: typeof import('@/actions/tools')
  keys: typeof import('@/actions/api-keys')
  credentials: typeof import('@/actions/credentials')
  projects: typeof import('@/actions/projects')
}
const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

beforeAll(async () => {
  // Nothing listens on port 1. Reset the process-wide client so the actions pick this URL up.
  vi.stubEnv('REDIS_URL', 'redis://127.0.0.1:1')
  ;(globalThis as Record<string, unknown>)['__webRedis'] = undefined
  ;(globalThis as Record<string, unknown>)['__webCacheInvalidator'] = undefined
  vi.resetModules()
  actions = {
    tools: await import('@/actions/tools'),
    keys: await import('@/actions/api-keys'),
    credentials: await import('@/actions/credentials'),
    projects: await import('@/actions/projects'),
  }

  const tag = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
  const user = await db.user.create({ data: { email: `down-${tag}@test.local`, name: 'down' } })
  users.push(user.id)
  session.userId = user.id
  slug = `down-${tag}`
  projectId = (await db.project.create({ data: { userId: user.id, name: 'Down', slug, upstreamBaseUrl: '' } })).id
  toolId = (
    await db.tool.create({
      data: {
        projectId,
        operationId: 'op',
        method: 'GET',
        path: '/x',
        name: 'op',
        description: 'd',
        specName: 'op',
        specDescription: 'd',
        inputSchema: { type: 'object', properties: {} },
      },
    })
  ).id
})

afterAll(async () => {
  await db.user.deleteMany({ where: { id: { in: users } } })
  vi.unstubAllEnvs()
  warn.mockRestore()
})

describe('dashboard actions with Redis down', () => {
  it('a tool edit still succeeds, is saved, and warns once', async () => {
    const started = Date.now()

    const res = await actions.tools.updateToolEnabled(toolId, false)

    expect(res).toEqual({})
    expect((await db.tool.findUniqueOrThrow({ where: { id: toolId } })).enabled).toBe(false)
    expect(Date.now() - started).toBeLessThan(5_000) // short timeouts, not a hang
    expect(warn).toHaveBeenCalled()
    expect(String(warn.mock.calls[0]![0])).toContain('relying on the TTL')
  })

  it('stops waiting on Redis after the first failure', async () => {
    const started = Date.now()
    for (let i = 0; i < 5; i++) expect(await actions.tools.updateToolEnabled(toolId, i % 2 === 0)).toEqual({})
    expect(Date.now() - started).toBeLessThan(1_500)
  })

  it('a description edit still succeeds', async () => {
    expect(await actions.tools.updateTool(toolId, { description: 'edited while Redis was down' })).toEqual({})
    expect((await db.tool.findUniqueOrThrow({ where: { id: toolId } })).description).toBe('edited while Redis was down')
  })

  it('revoking a key still revokes it in the database', async () => {
    const created = await actions.keys.createApiKey(slug, { name: 'k', rateLimitPerMin: 60 })

    expect(await actions.keys.revokeApiKey(slug, created.apiKey!.id)).toEqual({})

    expect((await db.apiKey.findUniqueOrThrow({ where: { id: created.apiKey!.id } })).revokedAt).not.toBeNull()
  })

  it('saving a credential still saves it', async () => {
    const res = await actions.credentials.updateCredential(slug, { type: 'BEARER', value: 'saved-while-down-1' })

    expect(res.error).toBeUndefined()
    expect(res.summary?.hasValue).toBe(true)
    expect(await db.upstreamCredential.findUnique({ where: { projectId } })).not.toBeNull()
  })

  it('saving project settings still saves them', async () => {
    const res = await actions.projects.updateProjectSettings(slug, { name: 'Renamed while down' })

    expect(res.error).toBeUndefined()
    expect((await db.project.findUniqueOrThrow({ where: { id: projectId } })).name).toBe('Renamed while down')
  })
})
