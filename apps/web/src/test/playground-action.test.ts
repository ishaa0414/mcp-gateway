/**
 * The runPlayground server action against the test database. The session, the environment and the
 * gateway (fetch) are stubbed; the action code, validation and Prisma queries are real.
 */
import { db } from '@mcp-gateway/db'
import { PLAYGROUND_HEADERS, playgroundRequestTimeoutMs, verifyPlaygroundRequest } from '@mcp-gateway/shared'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const session = vi.hoisted(() => ({ userId: '' }))
const settings = vi.hoisted(() => ({
  value: {} as Record<string, unknown>,
}))

vi.mock('@/auth', () => ({ auth: async () => (session.userId ? { user: { id: session.userId } } : null) }))
vi.mock('@/lib/env', async (importOriginal) => ({ ...(await importOriginal<typeof import('@/lib/env')>()), env: () => settings.value }))

import { runPlayground } from '@/actions/playground'

const SECRET = 'playground-secret-'.padEnd(40, 'x')
const ARG_SENTINEL = 'SENTINEL-ARGUMENT-4821'
const BODY_SENTINEL = 'SENTINEL-RESPONSE-9137'

const users: string[] = []
let slug: string
let otherSlug: string
const toolIds: Record<string, string> = {}

const fetchMock = vi.fn()

const run = (name: string, args: Record<string, unknown> = {}, extra: { confirmed?: boolean; slug?: string; toolId?: string } = {}) =>
  runPlayground({ slug: extra.slug ?? slug, toolId: extra.toolId ?? toolIds[name]!, arguments: args, ...(extra.confirmed !== undefined ? { confirmed: extra.confirmed } : {}) })

const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const okRun = {
  ok: true,
  errorClass: null,
  message: null,
  latencyMs: 12,
  request: { method: 'GET', url: 'https://api.example.com/pets/1', headers: { accept: '*/*' } },
  response: { status: 200, headers: { 'content-type': 'application/json' }, body: `{"note":"${BODY_SENTINEL}"}`, bodyBytes: 30, binary: false, truncated: false },
}

async function makeProject(label: string, userId: string) {
  const project = await db.project.create({
    data: { userId, name: label, slug: `pg-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, upstreamBaseUrl: 'https://api.example.com' },
  })
  const tool = (name: string, method: string, extra: Record<string, unknown> = {}) =>
    db.tool.create({
      data: {
        projectId: project.id, operationId: `op_${name}`, method, path: `/${name}`, name, description: 'd', specName: name, specDescription: 'd',
        inputSchema: { type: 'object', properties: {} }, ...extra,
      },
    })
  return { project, tool }
}

beforeAll(async () => {
  const owner = await db.user.create({ data: { email: `pg-owner-${Date.now()}@test.local`, name: 'Owner' } })
  const other = await db.user.create({ data: { email: `pg-other-${Date.now()}@test.local`, name: 'Other' } })
  users.push(owner.id, other.id)
  session.userId = owner.id

  const mine = await makeProject('mine', owner.id)
  slug = mine.project.slug
  toolIds['getPet'] = (await mine.tool('getPet', 'GET')).id
  toolIds['createPet'] = (await mine.tool('createPet', 'POST')).id
  toolIds['disabled'] = (await mine.tool('disabled', 'GET', { enabled: false })).id
  toolIds['removed'] = (await mine.tool('removed', 'GET', { removedAt: new Date() })).id

  const theirs = await makeProject('theirs', other.id)
  otherSlug = theirs.project.slug
  toolIds['theirs'] = (await theirs.tool('theirs', 'GET')).id
})

afterAll(async () => {
  await db.user.deleteMany({ where: { id: { in: users } } })
})

beforeEach(() => {
  settings.value = {
    PLAYGROUND_SECRET: SECRET,
    GATEWAY_PUBLIC_URL: 'http://gateway.public:4000',
    GATEWAY_INTERNAL_URL: undefined,
    TOOL_CALL_TIMEOUT_MS: 15_000,
  }
  fetchMock.mockReset()
  fetchMock.mockImplementation(async () => reply(okRun))
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('who can run what', () => {
  it('needs a signed-in user', async () => {
    session.userId = ''
    try {
      expect(await run('getPet')).toEqual({ status: 'unauthenticated' })
    } finally {
      session.userId = users[0]!
    }
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('rejects input that is not the right shape', async () => {
    expect(await runPlayground({ slug: 'NOT A SLUG', toolId: toolIds['getPet']!, arguments: {} })).toMatchObject({ status: 'invalid' })
    expect(await runPlayground({ slug, toolId: '', arguments: {} })).toMatchObject({ status: 'invalid' })
    expect(await runPlayground({ slug, toolId: toolIds['getPet']!, arguments: [] as never })).toMatchObject({ status: 'invalid' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("another user's project, another project's tool, a disabled tool, a removed tool and an unknown id all give the same not_found", async () => {
    const answers = [
      await run('theirs', {}, { slug: otherSlug }), // a project the user does not own
      await run('theirs'), // another project's tool under my slug
      await run('getPet', {}, { slug: otherSlug }), // my tool under their slug
      await run('disabled'),
      await run('removed'),
      await run('getPet', {}, { toolId: 'no-such-tool-id' }),
    ]
    for (const a of answers) expect(a).toEqual({ status: 'not_found' })
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('a tool that changes data', () => {
  it('is refused without confirmed: true, before any network call', async () => {
    expect(await run('createPet', { name: 'Rex' })).toEqual({ status: 'confirmation_required' })
    expect(await run('createPet', { name: 'Rex' }, { confirmed: false })).toEqual({ status: 'confirmation_required' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('runs once confirmed, and tells the gateway so', async () => {
    expect(await run('createPet', { name: 'Rex' }, { confirmed: true })).toMatchObject({ status: 'ok' })
    expect(JSON.parse(fetchMock.mock.calls[0]![1].body)).toEqual({ tool: 'createPet', arguments: { name: 'Rex' }, confirmed: true })
  })

  it('a GET needs no confirmation and sends none', async () => {
    expect(await run('getPet', { petId: 1 })).toMatchObject({ status: 'ok' })
    expect(JSON.parse(fetchMock.mock.calls[0]![1].body)).toEqual({ tool: 'getPet', arguments: { petId: 1 } })
  })
})

describe('configuration', () => {
  it('is not_configured without a secret, and makes no call', async () => {
    settings.value = { ...settings.value, PLAYGROUND_SECRET: undefined }
    expect(await run('getPet')).toEqual({ status: 'not_configured' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('calls the internal URL when set, else the public one', async () => {
    await run('getPet')
    expect(fetchMock.mock.calls[0]![0]).toBe(`http://gateway.public:4000/internal/playground/${slug}/run`)
    settings.value = { ...settings.value, GATEWAY_INTERNAL_URL: 'http://gateway.internal:4000/' }
    await run('getPet')
    expect(fetchMock.mock.calls[1]![0]).toBe(`http://gateway.internal:4000/internal/playground/${slug}/run`)
  })

  it('waits for the gateway timeout plus the shared margin', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout')
    settings.value = { ...settings.value, TOOL_CALL_TIMEOUT_MS: 7_000 }
    await run('getPet')
    expect(timeout).toHaveBeenCalledWith(playgroundRequestTimeoutMs(7_000))
    expect(fetchMock.mock.calls[0]![1].signal).toBeInstanceOf(AbortSignal)
  })
})

describe('what is sent to the gateway', () => {
  it('is signed so that the shared verifier accepts it, over the exact body text', async () => {
    await run('createPet', { name: 'Rex', nested: { a: [1, 2] } }, { confirmed: true })
    const [url, init] = fetchMock.mock.calls[0]!
    const headers = init.headers as Record<string, string>
    const parts = {
      timestamp: Number(headers[PLAYGROUND_HEADERS.timestamp]),
      nonce: headers[PLAYGROUND_HEADERS.nonce]!,
      slug,
      tool: 'createPet',
      body: init.body as string,
    }
    expect(url).toContain(`/internal/playground/${slug}/run`)
    expect(init.method).toBe('POST')
    expect(verifyPlaygroundRequest(SECRET, parts, headers[PLAYGROUND_HEADERS.signature]!)).toBe('ok')
    expect(verifyPlaygroundRequest('x'.repeat(40), parts, headers[PLAYGROUND_HEADERS.signature]!)).toBe('bad_signature')
    expect(Math.abs(parts.timestamp - Date.now())).toBeLessThan(5_000)
    expect(parts.nonce).toMatch(/^[0-9a-f]{32}$/)
  })

  it('uses a new nonce for each run, even for identical runs', async () => {
    await run('getPet', { petId: 1 })
    await run('getPet', { petId: 1 })
    const nonces = fetchMock.mock.calls.map((c) => (c[1].headers as Record<string, string>)[PLAYGROUND_HEADERS.nonce])
    expect(new Set(nonces).size).toBe(2)
  })
})

describe('what the gateway answers', () => {
  const answer = async (response: Response | Error) => {
    fetchMock.mockImplementation(async () => {
      if (response instanceof Error) throw response
      return response
    })
    return run('getPet', { petId: 1 })
  }

  it('a run: handed back as it is, including a tool that failed upstream', async () => {
    expect(await answer(reply(okRun))).toEqual({ status: 'ok', run: okRun })
    const failed = { ...okRun, ok: false, errorClass: 'UPSTREAM_4XX', message: 'The upstream API returned HTTP 404 Not Found.' }
    expect(await answer(reply(failed))).toEqual({ status: 'ok', run: failed })
  })

  it('a validation error: invalid, with the gateway message untouched', async () => {
    const message = 'Invalid arguments for "getPet": data must have required property \'petId\''
    expect(await answer(reply({ ...okRun, ok: false, errorClass: 'VALIDATION', message, request: null, response: null }))).toEqual({ status: 'invalid', message })
  })

  it('429: rate_limited, with the wait', async () => {
    expect(await answer(reply({ error: 'rate_limited', limit: 30, retryAfterSeconds: 41 }, 429))).toEqual({ status: 'rate_limited', retryAfterSeconds: 41 })
    expect(await answer(reply({ error: 'rate_limited' }, 429))).toEqual({ status: 'rate_limited', retryAfterSeconds: 60 })
  })

  it('404: not_found', async () => {
    expect(await answer(reply({ error: 'not_found' }, 404))).toEqual({ status: 'not_found' })
  })

  it('400 confirmation_required: confirmation_required', async () => {
    expect(await answer(reply({ error: 'confirmation_required', method: 'POST', path: '/pets' }, 400))).toEqual({ status: 'confirmation_required' })
  })

  it('401 unauthorized: misconfigured, logged on the server without a payload', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    expect(await answer(reply({ error: 'unauthorized' }, 401))).toEqual({ status: 'misconfigured' })
    expect(error).toHaveBeenCalledTimes(1)
    expect(String(error.mock.calls[0]![0])).toMatch(/PLAYGROUND_SECRET/)
  })

  it('401 replayed, 503, any other status and an unreadable body: unavailable', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    expect(await answer(reply({ error: 'replayed' }, 401))).toEqual({ status: 'unavailable' })
    expect(await answer(reply({ error: 'playground_unavailable' }, 503))).toEqual({ status: 'unavailable' })
    expect(await answer(reply({}, 500))).toEqual({ status: 'unavailable' })
    expect(await answer(new Response('<html>bad gateway</html>', { status: 502 }))).toEqual({ status: 'unavailable' })
    expect(await answer(reply({ unexpected: true }))).toEqual({ status: 'unavailable' })
  })

  it('a network error: unavailable; a timeout: gateway_timeout', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    expect(await answer(new TypeError('fetch failed'))).toEqual({ status: 'unavailable' })
    expect(await answer(new DOMException('The operation timed out.', 'TimeoutError'))).toEqual({ status: 'gateway_timeout' })
    expect(await answer(new DOMException('aborted', 'AbortError'))).toEqual({ status: 'gateway_timeout' })
  })
})

describe('logging', () => {
  it('never writes the arguments, the request or the response to any log', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => undefined))
    await run('getPet', { petId: 1, note: ARG_SENTINEL }) // ok, with a sentinel in the response body
    fetchMock.mockImplementation(async () => reply({ error: 'unauthorized' }, 401))
    await run('getPet', { note: ARG_SENTINEL })
    fetchMock.mockImplementation(async () => {
      throw new TypeError('fetch failed')
    })
    await run('getPet', { note: ARG_SENTINEL })

    const written = JSON.stringify(spies.flatMap((s) => s.mock.calls))
    expect(written).not.toContain(ARG_SENTINEL)
    expect(written).not.toContain(BODY_SENTINEL)
    expect(written).not.toContain(SECRET)
  })
})
