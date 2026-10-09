import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  cleanupFixtures,
  connectV1,
  connectV2,
  createFixture,
  json,
  rpc,
  startGateway,
  startUpstream,
  textOf,
  type Fixture,
  type MockUpstream,
  type RunningGateway,
} from './harness.js'

let gateway: RunningGateway
let upstream: MockUpstream
let fx: Fixture

beforeAll(async () => {
  vi.stubEnv('NODE_ENV', 'development')
  vi.stubEnv('ALLOW_PRIVATE_UPSTREAMS', 'true')

  upstream = await startUpstream((req, res) => json(res, { path: req.url }))
  gateway = await startGateway()
  fx = await createFixture({
    upstreamBaseUrl: upstream.url,
    disabled: ['deletePet'],
    removed: ['moved'],
    hidden: { listTenantItems: { tenant: { value: 'acme' } } },
  })
})

afterAll(async () => {
  await gateway.close()
  await upstream.close()
  await cleanupFixtures()
  vi.unstubAllEnvs()
})

describe('tools/list', () => {
  it('returns only enabled, non-removed tools', async () => {
    const client = await connectV2(gateway.mcpUrl(fx.slug), fx.apiKey)
    const { tools } = await client.listTools()
    await client.close()

    const names = tools.map((t) => t.name).sort()
    expect(names).toEqual(
      ['big', 'createPet', 'emptyThing', 'getPet', 'image', 'listPets', 'listTenantItems', 'slow', 'updatePet', 'updateThing'].sort()
    )
    expect(names).not.toContain('deletePet') // disabled
    expect(names).not.toContain('moved') // removed from the spec
  })

  it('shows the agent schema: hidden parameters are gone, and so are their required entries', async () => {
    const client = await connectV2(gateway.mcpUrl(fx.slug), fx.apiKey)
    const { tools } = await client.listTools()
    await client.close()

    const tenantTool = tools.find((t) => t.name === 'listTenantItems')!
    expect(Object.keys(tenantTool.inputSchema.properties ?? {})).toEqual(['q'])
    expect(tenantTool.inputSchema.required ?? []).not.toContain('tenant')

    // Others are untouched.
    const getPet = tools.find((t) => t.name === 'getPet')!
    expect(Object.keys(getPet.inputSchema.properties ?? {}).sort()).toEqual(['X-Trace', 'petId', 'verbose'])
    expect(getPet.inputSchema.required).toEqual(['petId'])
    expect(getPet.description).toBe('Get a pet')
  })

  it('annotates each tool from its HTTP method', async () => {
    const client = await connectV2(gateway.mcpUrl(fx.slug), fx.apiKey)
    const { tools } = await client.listTools()
    await client.close()
    const hints = (name: string) => tools.find((t) => t.name === name)!.annotations

    expect(hints('getPet')).toMatchObject({ readOnlyHint: true, destructiveHint: false, openWorldHint: true }) // GET
    expect(hints('emptyThing')).toMatchObject({ readOnlyHint: false, destructiveHint: true, idempotentHint: true }) // DELETE
    expect(hints('updatePet')).toMatchObject({ readOnlyHint: false, destructiveHint: false, idempotentHint: true }) // PUT
    expect(hints('createPet')).toMatchObject({ readOnlyHint: false, destructiveHint: false, idempotentHint: false }) // POST
  })

  it('renames clashing arguments in the schema (body id vs path id)', async () => {
    const client = await connectV2(gateway.mcpUrl(fx.slug), fx.apiKey)
    const { tools } = await client.listTools()
    await client.close()

    const update = tools.find((t) => t.name === 'updateThing')!
    expect(Object.keys(update.inputSchema.properties ?? {}).sort()).toEqual(['body_id', 'id', 'name'])
  })

  it('works over raw JSON-RPC with no initialize and no session', async () => {
    const res = await rpc(gateway.mcpUrl(fx.slug), fx.apiKey, 'tools/list')
    expect(res.status).toBe(200)
    expect(res.body.result.tools.length).toBeGreaterThan(0)
    expect(res.headers.get('mcp-session-id')).toBeNull()
  })
})

describe('older and newer protocol clients', () => {
  it('serves a v1 SDK client (spec 2025-11-25): it can list and call tools', async () => {
    const client = await connectV1(gateway.mcpUrl(fx.slug), fx.apiKey)

    const { tools } = await client.listTools()
    expect(tools.map((t) => t.name)).toContain('getPet')

    const result = await client.callTool({ name: 'getPet', arguments: { petId: 7 } })
    await client.close()

    expect(result.isError).toBeFalsy()
    expect(JSON.parse(textOf(result))).toEqual({ path: '/pets/7' })
  })

  it('serves the v2 client on the legacy handshake', async () => {
    const client = await connectV2(gateway.mcpUrl(fx.slug), fx.apiKey, 'legacy')
    const result = await client.callTool({ name: 'getPet', arguments: { petId: 8 } })
    await client.close()
    expect(JSON.parse(textOf(result))).toEqual({ path: '/pets/8' })
  })

  it('serves the v2 client on the 2026-07-28 protocol (auto-negotiated and pinned)', async () => {
    for (const mode of ['auto', { pin: '2026-07-28' }] as const) {
      const client = await connectV2(gateway.mcpUrl(fx.slug), fx.apiKey, mode)
      const { tools } = await client.listTools()
      const result = await client.callTool({ name: 'getPet', arguments: { petId: 9 } })
      await client.close()

      expect(tools.map((t) => t.name)).toContain('getPet')
      expect(JSON.parse(textOf(result))).toEqual({ path: '/pets/9' })
    }
  })
})

describe('stateless endpoint', () => {
  it.each(['GET', 'DELETE'])('answers %s with 405 and an Allow header', async (method) => {
    const res = await fetch(gateway.mcpUrl(fx.slug), { method, headers: { authorization: `Bearer ${fx.apiKey}` } })
    expect(res.status).toBe(405)
    expect(res.headers.get('allow')).toBe('POST')
  })

  it('answers invalid JSON with a JSON-RPC parse error, not a stack trace', async () => {
    const res = await fetch(gateway.mcpUrl(fx.slug), {
      method: 'POST',
      headers: { authorization: `Bearer ${fx.apiKey}`, 'content-type': 'application/json' },
      body: '{not json',
    })
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: { code: number } }).error.code).toBe(-32700)
  })

  it('sets CORS headers on real responses and answers preflight', async () => {
    const preflight = await fetch(gateway.mcpUrl(fx.slug), {
      method: 'OPTIONS',
      headers: { origin: 'https://app.example', 'access-control-request-method': 'POST', 'access-control-request-headers': 'authorization,content-type' },
    })
    expect(preflight.status).toBeLessThan(300)
    expect(preflight.headers.get('access-control-allow-headers')).toContain('authorization')

    const res = await rpc(gateway.mcpUrl(fx.slug), fx.apiKey, 'tools/list', undefined, { origin: 'https://app.example' })
    expect(res.status).toBe(200)
    expect(res.headers.get('access-control-allow-origin')).toBe('https://app.example')
  })
})
