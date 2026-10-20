/**
 * The signed internal playground route: real Postgres and Redis, a real gateway, a local upstream.
 */
import { db } from '@mcp-gateway/db'
import { newPlaygroundNonce, PLAYGROUND_HEADERS, signPlaygroundRequest } from '@mcp-gateway/shared'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  cleanupFixtures,
  createFixture,
  json,
  startGateway,
  startUpstream,
  type CollectingSink,
  type Fixture,
  type MockUpstream,
  type RunningGateway,
} from './harness.js'

const SECRET = 'playground-secret-'.padEnd(40, 'x')
const BEARER = 'tok-bearer-4f9a7c21'
const HIDDEN_TAG = 'hidden-tag-value-8d21'
const HIDDEN_TENANT = 'acme-hidden-tenant'

let upstream: MockUpstream
let gateway: RunningGateway
let fx: Fixture

beforeAll(async () => {
  vi.stubEnv('NODE_ENV', 'development')
  vi.stubEnv('ALLOW_PRIVATE_UPSTREAMS', 'true')
  // Echoes what it received, credential included, like a careless upstream.
  upstream = await startUpstream((req, res, rec) =>
    json(res, { url: req.url, authorization: req.headers['authorization'] ?? null, body: rec.body })
  )
  gateway = await startGateway({ config: { playgroundSecret: SECRET } })
  fx = await fixtureFor()
})

afterAll(async () => {
  await gateway.close()
  await upstream.close()
  await cleanupFixtures()
  vi.unstubAllEnvs()
})

beforeEach(() => {
  upstream.requests.length = 0
  vi.stubEnv('NODE_ENV', 'development')
  vi.stubEnv('ALLOW_PRIVATE_UPSTREAMS', 'true')
})

const fixtureFor = () =>
  createFixture({
    upstreamBaseUrl: upstream.url,
    credential: { type: 'BEARER', value: BEARER },
    hidden: { createPet: { tag: { value: HIDDEN_TAG } }, listTenantItems: { tenant: { value: HIDDEN_TENANT } } },
    disabled: ['deletePet'],
    removed: ['updateThing'],
  })

interface RunOptions {
  gw?: RunningGateway
  fixture?: Fixture
  slug?: string
  arguments?: Record<string, unknown>
  confirmed?: boolean
  secret?: string
  timestamp?: number
  nonce?: string
  /** Sign this tool name, though the body says another. */
  signedTool?: string
  signedSlug?: string
  /** Send this body, though the signature was made for the real one. */
  sendBody?: string
}

/** One signed call to the playground route. */
async function run(tool: string, o: RunOptions = {}) {
  const gw = o.gw ?? gateway
  const slug = o.slug ?? (o.fixture ?? fx).slug
  const body = JSON.stringify({ tool, arguments: o.arguments ?? {}, ...(o.confirmed !== undefined ? { confirmed: o.confirmed } : {}) })
  const timestamp = o.timestamp ?? Date.now()
  const nonce = o.nonce ?? newPlaygroundNonce()
  const signature = signPlaygroundRequest(o.secret ?? SECRET, { timestamp, nonce, slug: o.signedSlug ?? slug, tool: o.signedTool ?? tool, body })
  const res = await fetch(`${gw.baseUrl}/internal/playground/${slug}/run`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      [PLAYGROUND_HEADERS.timestamp]: String(timestamp),
      [PLAYGROUND_HEADERS.nonce]: nonce,
      [PLAYGROUND_HEADERS.signature]: signature,
    },
    body: o.sendBody ?? body,
  })
  const text = await res.text()
  let parsed: Record<string, any> = {} // eslint-disable-line @typescript-eslint/no-explicit-any
  try {
    parsed = JSON.parse(text)
  } catch {
    // leave empty
  }
  return { status: res.status, headers: res.headers, text, json: parsed }
}

describe('a valid signed request', () => {
  it('runs a GET tool and returns the masked request and response', async () => {
    const res = await run('getPet', { arguments: { petId: 7, verbose: true } })
    expect(res.status).toBe(200)
    expect(res.json).toMatchObject({
      ok: true,
      errorClass: null,
      request: { method: 'GET', url: `${upstream.url}/pets/7?verbose=true`, headers: { authorization: 'Bearer ••••' } },
      response: { status: 200, binary: false, truncated: false },
    })
    expect(JSON.parse(res.json['response'].body)).toMatchObject({ url: '/pets/7?verbose=true' })
    // The real call carried the real credential.
    expect(upstream.requests).toHaveLength(1)
    expect(upstream.requests[0]!.headers['authorization']).toBe(`Bearer ${BEARER}`)
  })

  it('reports the gateway validation message as-is, with no request or response', async () => {
    const res = await run('getPet', { arguments: { petId: 'seven' } })
    expect(res.status).toBe(200)
    expect(res.json).toMatchObject({ ok: false, errorClass: 'VALIDATION', request: null, response: null })
    expect(res.json['message']).toMatch(/^Invalid arguments for "getPet": .*petId/)
    expect(upstream.requests).toHaveLength(0)
  })

  it('never puts the credential anywhere in the response body, and shows hidden values as HIDDEN in the request', async () => {
    const posted = await run('createPet', { arguments: { name: 'Rex' }, confirmed: true })
    const listed = await run('listTenantItems', { arguments: { q: 'x' } })
    for (const res of [posted, listed]) {
      expect(res.status).toBe(200)
      expect(res.text).not.toContain(BEARER) // the credential is the one thing redacted, on the request and the response
      expect(JSON.stringify(res.json['request'])).not.toMatch(new RegExp(`${HIDDEN_TAG}|${HIDDEN_TENANT}`)) // the request side
    }
    // Both calls really used them.
    expect(upstream.requests[0]!.body).toContain(HIDDEN_TAG)
    expect(upstream.requests[1]!.url).toContain(HIDDEN_TENANT)
    // The request shows the placeholder instead.
    expect(JSON.parse(posted.json['request'].body)).toEqual({ name: 'Rex', tag: 'HIDDEN' })
    expect(listed.json['request'].url).toContain('tenant=HIDDEN')
    // A hidden value is a plain setting, not a secret: when the upstream echoes it, the response shows it as sent.
    expect(JSON.parse(posted.json['response'].body).body).toContain(HIDDEN_TAG)
  })

  it('writes no call-log row and queues no event', async () => {
    const before = await db.toolCallLog.count({ where: { projectId: fx.projectId } })
    await run('getPet', { arguments: { petId: 1 } })
    await run('getPet', { arguments: { petId: 'bad' } })
    await run('createPet', { arguments: { name: 'Rex' }, confirmed: true })
    expect(await db.toolCallLog.count({ where: { projectId: fx.projectId } })).toBe(before)
    expect((gateway.logSink as CollectingSink).events).toHaveLength(0)
  })
})

describe('a request that must be refused', () => {
  const noUpstreamCall = () => expect(upstream.requests).toHaveLength(0)

  it('with the wrong secret', async () => {
    const res = await run('getPet', { arguments: { petId: 1 }, secret: 'z'.repeat(40) })
    expect(res.status).toBe(401)
    noUpstreamCall()
  })

  it('with a tampered body', async () => {
    const res = await run('getPet', { arguments: { petId: 1 }, sendBody: JSON.stringify({ tool: 'getPet', arguments: { petId: 2 } }) })
    expect(res.status).toBe(401)
    noUpstreamCall()
  })

  it('signed for another slug', async () => {
    const res = await run('getPet', { arguments: { petId: 1 }, signedSlug: 'some-other-project' })
    expect(res.status).toBe(401)
    noUpstreamCall()
  })

  it('signed for another tool', async () => {
    const res = await run('getPet', { arguments: { petId: 1 }, signedTool: 'createPet' })
    expect(res.status).toBe(401)
    noUpstreamCall()
  })

  it('with a timestamp more than the window in the past', async () => {
    const res = await run('getPet', { arguments: { petId: 1 }, timestamp: Date.now() - 61_000 })
    expect(res.status).toBe(401)
    noUpstreamCall()
  })

  it('with a timestamp more than the window in the future', async () => {
    const res = await run('getPet', { arguments: { petId: 1 }, timestamp: Date.now() + 61_000 })
    expect(res.status).toBe(401)
    noUpstreamCall()
  })

  it('with a nonce that is too short', async () => {
    const res = await run('getPet', { arguments: { petId: 1 }, nonce: 'ab'.repeat(15) })
    expect(res.status).toBe(401)
    noUpstreamCall()
  })

  it('that is a replay of an accepted one (same nonce), even with a valid signature', async () => {
    const nonce = newPlaygroundNonce()
    const timestamp = Date.now()
    const first = await run('getPet', { arguments: { petId: 1 }, nonce, timestamp })
    const second = await run('getPet', { arguments: { petId: 1 }, nonce, timestamp })
    expect(first.status).toBe(200)
    expect(second.status).toBe(401)
    expect(second.json).toEqual({ error: 'replayed' })
    expect(upstream.requests).toHaveLength(1)
  })

  it('and the nonce is kept for at least the whole window', async () => {
    const nonce = newPlaygroundNonce()
    await run('getPet', { arguments: { petId: 1 }, nonce })
    const ttl = await gateway.redis.ttl(`mcp:pg:nonce:${nonce}`)
    expect(ttl).toBeGreaterThanOrEqual(60)
  })
})

describe('Redis unavailable', () => {
  it('refuses the request ("playground unavailable") instead of skipping the replay check', async () => {
    const noRedis = await startGateway({ redisUrl: 'redis://127.0.0.1:1', config: { playgroundSecret: SECRET } })
    try {
      const res = await run('getPet', { gw: noRedis, arguments: { petId: 1 } })
      expect(res.status).toBe(503)
      expect(res.json).toMatchObject({ error: 'playground_unavailable' })
      expect(res.json['message']).toMatch(/unavailable/i)
      expect(upstream.requests).toHaveLength(0)
    } finally {
      await noRedis.close()
    }
  })
})

describe('without PLAYGROUND_SECRET', () => {
  it('the route does not exist', async () => {
    const plain = await startGateway()
    try {
      const res = await run('getPet', { gw: plain, arguments: { petId: 1 } })
      expect(res.status).toBe(404)
      expect(upstream.requests).toHaveLength(0)
    } finally {
      await plain.close()
    }
  })
})

describe('which tools can be run', () => {
  it('an unknown project, a disabled tool, a removed tool and an unknown tool all get the identical not_found', async () => {
    const answers = [
      await run('getPet', { slug: 'no-such-project', arguments: { petId: 1 } }),
      await run('deletePet', { arguments: { petId: 1 }, confirmed: true }), // disabled
      await run('updateThing', { arguments: { id: 1 }, confirmed: true }), // removed
      await run('noSuchTool', { confirmed: true }),
    ]
    for (const a of answers) expect(a.status).toBe(404)
    expect(new Set(answers.map((a) => a.text)).size).toBe(1)
    expect(answers[0]!.json).toEqual({ error: 'not_found' })
    expect(upstream.requests).toHaveLength(0)
  })

  it('a tool that is disabled in this project does not run, whatever the other projects have', async () => {
    const other = await createFixture({ upstreamBaseUrl: upstream.url, disabled: ['getPet'] })
    const res = await run('getPet', { fixture: other, arguments: { petId: 1 } })
    expect(res.status).toBe(404)
    expect(upstream.requests).toHaveLength(0)
  })
})

describe('tools that change something', () => {
  it('need confirmed: true; a GET does not', async () => {
    const missing = await run('createPet', { arguments: { name: 'Rex' } })
    const no = await run('createPet', { arguments: { name: 'Rex' }, confirmed: false })
    expect(missing.status).toBe(400)
    expect(missing.json).toEqual({ error: 'confirmation_required', method: 'POST', path: '/pets' })
    expect(no.status).toBe(400)
    expect(upstream.requests).toHaveLength(0)

    const yes = await run('createPet', { arguments: { name: 'Rex' }, confirmed: true })
    expect(yes.status).toBe(200)
    expect(yes.json['request']).toMatchObject({ method: 'POST' })
    expect(upstream.requests).toHaveLength(1)

    expect((await run('getPet', { arguments: { petId: 1 } })).status).toBe(200)
  })
})

describe('the per-project limit', () => {
  it('allows 30 calls a minute and refuses the 31st, with Retry-After', async () => {
    const f = await fixtureFor()
    for (let i = 1; i <= 30; i++) expect((await run('getPet', { fixture: f, arguments: { petId: i } })).status).toBe(200)
    const over = await run('getPet', { fixture: f, arguments: { petId: 31 } })
    expect(over.status).toBe(429)
    expect(over.json).toMatchObject({ error: 'rate_limited', limit: 30 })
    expect(Number(over.headers.get('retry-after'))).toBeGreaterThanOrEqual(1)
    expect(upstream.requests).toHaveLength(30)
  })

  it('is per project, and uses its own limit when configured', async () => {
    const small = await startGateway({ config: { playgroundSecret: SECRET, playgroundRatePerMin: 2 } })
    try {
      const [a, b] = [await fixtureFor(), await fixtureFor()]
      const statuses = []
      for (let i = 0; i < 3; i++) statuses.push((await run('getPet', { gw: small, fixture: a, arguments: { petId: 1 } })).status)
      expect(statuses).toEqual([200, 200, 429])
      expect((await run('getPet', { gw: small, fixture: b, arguments: { petId: 1 } })).status).toBe(200)
    } finally {
      await small.close()
    }
  })

  it('does not touch the API-key limiter keys', async () => {
    await run('getPet', { arguments: { petId: 1 } })
    expect(await gateway.redis.keys(`mcp:rl:${fx.apiKeyId}`)).toEqual([])
  })
})
