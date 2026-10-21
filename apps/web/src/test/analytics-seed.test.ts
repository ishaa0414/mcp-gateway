/**
 * The analytics seed script: refuses production and non-local databases, is scoped to one
 * project, is repeatable, and produces rows that pass the same validation as real ones.
 */
import { describe, it, expect, afterAll } from 'vitest'
import { db } from '@mcp-gateway/db'
import { seedAnalyticsLogs, assertSeedAllowed, buildSeedEvents, SeedRefusedError } from '@mcp-gateway/db/seed'
import { logEventSchema } from '@mcp-gateway/shared/log-event'

const LOCAL = { NODE_ENV: 'development', DATABASE_URL: 'postgresql://u:p@localhost:5432/mcpgateway_test' }
const NOW = Date.UTC(2026, 9, 12, 10, 0, 0)

const userIds: string[] = []

/** Every test that touches the database makes its own user and project, so no test can see another's rows. */
async function makeProject(label: string) {
  const tag = `${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const user = await db.user.create({ data: { email: `seed-${tag}@test.local`, name: 'Seed' } })
  userIds.push(user.id)
  return db.project.create({
    data: { userId: user.id, name: label, slug: `seed-${tag}`, upstreamBaseUrl: 'https://api.example.com' },
    select: { id: true, slug: true },
  })
}

afterAll(async () => {
  await db.user.deleteMany({ where: { id: { in: userIds } } }) // projects and logs cascade
  await db.$disconnect()
})

describe('assertSeedAllowed', () => {
  it('refuses NODE_ENV=production, even with a local database', () => {
    expect(() => assertSeedAllowed({ ...LOCAL, NODE_ENV: 'production' })).toThrow(SeedRefusedError)
    expect(() => assertSeedAllowed({ ...LOCAL, NODE_ENV: 'production' })).toThrow(/production/)
  })

  it.each(['localhost', '127.0.0.1', '[::1]'])('allows the local host %s', (host) => {
    expect(() => assertSeedAllowed({ NODE_ENV: 'development', DATABASE_URL: `postgresql://u:p@${host}:5432/db` })).not.toThrow()
  })

  it('allows an unset NODE_ENV with a local database', () => {
    expect(() => assertSeedAllowed({ DATABASE_URL: LOCAL.DATABASE_URL })).not.toThrow()
  })

  it.each(['db.example.com', '10.0.0.5', 'localhost.evil.com'])('refuses the non-local host %s', (host) => {
    expect(() => assertSeedAllowed({ NODE_ENV: 'development', DATABASE_URL: `postgresql://u:p@${host}:5432/db` })).toThrow(/not localhost/)
  })

  it('refuses a missing or invalid DATABASE_URL', () => {
    expect(() => assertSeedAllowed({ NODE_ENV: 'development' })).toThrow(SeedRefusedError)
    expect(() => assertSeedAllowed({ NODE_ENV: 'development', DATABASE_URL: 'not a url' })).toThrow(SeedRefusedError)
  })
})

describe('seedAnalyticsLogs', () => {
  // Creates a user and project, seeds it, counts its rows, then counts again after a refused seed: many sequential
  // database round trips. 0.44 s idle, 5.1 s with the CPU starved, so it gets its own limit instead of the 5 s default.
  it('writes nothing and touches nothing in production', { timeout: 30_000 }, async () => {
    const project = await makeProject('prod')
    await seedAnalyticsLogs(db, { projectSlug: project.slug, rows: 5, now: NOW }, LOCAL)
    const before = await db.toolCallLog.count({ where: { projectId: project.id } })

    await expect(seedAnalyticsLogs(db, { projectSlug: project.slug, now: NOW }, { ...LOCAL, NODE_ENV: 'production' })).rejects.toThrow(
      SeedRefusedError
    )
    expect(before).toBe(5)
    expect(await db.toolCallLog.count({ where: { projectId: project.id } })).toBe(before)
  })

  it('rejects an unknown project and a bad row count', async () => {
    const project = await makeProject('rows')
    await expect(seedAnalyticsLogs(db, { projectSlug: 'no-such-project', now: NOW }, LOCAL)).rejects.toThrow(/No project/)
    await expect(seedAnalyticsLogs(db, { projectSlug: project.slug, rows: 0 }, LOCAL)).rejects.toThrow(/--rows/)
    await expect(seedAnalyticsLogs(db, { projectSlug: project.slug, rows: 100_001 }, LOCAL)).rejects.toThrow(/--rows/)
    expect(await db.toolCallLog.count({ where: { projectId: project.id } })).toBe(0)
  })

  // Two seeds, a count and a read: 0.25 s idle, 5.0 s with the CPU starved.
  it('inserts rows with project-scoped ids and past timestamps, and a re-run replaces them', { timeout: 30_000 }, async () => {
    const project = await makeProject('rerun')
    const first = await seedAnalyticsLogs(db, { projectSlug: project.slug, rows: 30, now: NOW }, LOCAL)
    expect(first).toMatchObject({ projectId: project.id, deleted: 0, written: 30 })

    const rows = await db.toolCallLog.findMany({ where: { projectId: project.id } })
    expect(rows).toHaveLength(30)
    expect(rows.every((r) => r.id.startsWith(`seed_${project.id}_`))).toBe(true)
    // The explicit past created_at is kept: everything falls inside the 7 days before NOW.
    const times = rows.map((r) => r.createdAt.getTime())
    expect(Math.max(...times)).toBeLessThanOrEqual(NOW)
    expect(Math.min(...times)).toBeGreaterThanOrEqual(NOW - 7 * 24 * 3600 * 1000)

    const second = await seedAnalyticsLogs(db, { projectSlug: project.slug, rows: 30, now: NOW }, LOCAL)
    expect(second).toMatchObject({ deleted: 30, written: 30 })
    expect(await db.toolCallLog.count({ where: { projectId: project.id } })).toBe(30)
  })

  // Three seeds across two projects and three counts: 0.16 s idle, 2.6 s with the CPU starved.
  it("never deletes a real row or another project's seed rows", { timeout: 30_000 }, async () => {
    const [a, b] = [await makeProject('scope-a'), await makeProject('scope-b')]
    await seedAnalyticsLogs(db, { projectSlug: b.slug, rows: 10, now: NOW }, LOCAL)
    await seedAnalyticsLogs(db, { projectSlug: a.slug, rows: 5, now: NOW }, LOCAL)
    await db.toolCallLog.create({
      data: { id: `real-${a.id}`, projectId: a.id, toolName: 'listPets', input: {}, latencyMs: 5, success: true, createdAt: new Date(NOW) },
    })

    await seedAnalyticsLogs(db, { projectSlug: a.slug, rows: 8, now: NOW }, LOCAL)

    expect(await db.toolCallLog.count({ where: { id: `real-${a.id}` } })).toBe(1)
    expect(await db.toolCallLog.count({ where: { projectId: b.id } })).toBe(10)
    expect(await db.toolCallLog.count({ where: { projectId: a.id } })).toBe(9) // 8 new seed rows replaced the 5 old ones, plus the real row
  })
})

describe('buildSeedEvents', () => {
  const params = { projectId: 'pid', projectSlug: 'slug', tools: [], rows: 400, now: NOW }

  it('is deterministic', () => {
    expect(buildSeedEvents(params)).toEqual(buildSeedEvents(params))
    expect(buildSeedEvents({ ...params, seed: 2 })).not.toEqual(buildSeedEvents(params))
  })

  it('produces valid events with mixed tools, errors, latencies and the odd auth failure or rate limit', () => {
    const events = buildSeedEvents(params)
    expect(events).toHaveLength(400)
    for (const e of events) expect(logEventSchema.safeParse(e).success).toBe(true)
    expect(new Set(events.map((e) => e.id)).size).toBe(400)

    const calls = events.filter((e) => e.kind === 'TOOL_CALL')
    expect(new Set(calls.map((e) => e.toolName)).size).toBeGreaterThan(3)
    expect(events.some((e) => !e.success && e.errorClass === 'UPSTREAM_5XX')).toBe(true)
    expect(events.some((e) => e.kind === 'AUTH_FAILURE')).toBe(true)
    expect(events.some((e) => e.errorClass === 'RATE_LIMITED')).toBe(true)
    const okLatencies = calls.filter((e) => e.success).map((e) => e.latencyMs)
    expect(Math.max(...okLatencies)).toBeGreaterThan(Math.min(...okLatencies) * 5)
    const errorRate = events.filter((e) => !e.success).length / events.length
    expect(errorRate).toBeGreaterThan(0.05)
    expect(errorRate).toBeLessThan(0.3)
  })
})

describe('seeded tool inputs', () => {
  const loginSchema = {
    type: 'object',
    properties: { username: { type: 'string' }, password: { type: 'string' } },
    required: ['username', 'password'],
  }
  const petSchema = {
    type: 'object',
    properties: { petId: { type: 'integer', minimum: 1, maximum: 9 }, status: { type: 'string', enum: ['available', 'sold'] }, region: { type: 'string' } },
    required: ['petId'],
  }
  const tools = [
    { id: null, name: 'loginUser', inputSchema: loginSchema },
    { id: null, name: 'getPet', inputSchema: petSchema, hiddenParams: { region: 'eu' } },
  ]
  const events = buildSeedEvents({ projectId: 'pid', projectSlug: 'slug', tools, rows: 600, now: NOW })
  const callsOf = (name: string) => events.filter((e) => e.kind === 'TOOL_CALL' && e.errorClass !== 'VALIDATION' && e.toolName === name && Object.keys(e.input).length > 0)

  it('loginUser sends a username and a password, and the password is masked like a real row', () => {
    const logins = callsOf('loginUser')
    expect(logins.length).toBeGreaterThan(20)
    for (const e of logins) {
      expect(Object.keys(e.input).sort()).toEqual(['password', 'username'])
      expect(e.input['password']).toBe('[MASKED]')
      expect(typeof e.input['username']).toBe('string')
      expect(e.input['username']).not.toBe('[MASKED]')
    }
    // No raw sample password anywhere in the output.
    expect(JSON.stringify(events)).not.toMatch(/-Pw!/)
  })

  it("every other tool sends only its own parameters, within their types and bounds, and never a hidden one", () => {
    const pets = callsOf('getPet')
    expect(pets.length).toBeGreaterThan(20)
    for (const e of pets) {
      expect(Object.keys(e.input)).not.toContain('region')
      expect(Object.keys(e.input).every((k) => k === 'petId' || k === 'status')).toBe(true)
      expect(Number.isInteger(e.input['petId'])).toBe(true)
      expect(e.input['petId'] as number).toBeGreaterThanOrEqual(1)
      expect(e.input['petId'] as number).toBeLessThanOrEqual(9)
      if ('status' in e.input) expect(['available', 'sold']).toContain(e.input['status'])
    }
  })

  it('the Petstore fallback (no tools) includes loginUser with a masked password', () => {
    const fallback = buildSeedEvents({ projectId: 'pid', projectSlug: 'slug', tools: [], rows: 3000, now: NOW })
    const logins = fallback.filter((e) => e.toolName === 'loginUser' && e.errorClass !== 'VALIDATION' && Object.keys(e.input).length > 0)
    expect(logins.length).toBeGreaterThan(0)
    expect(logins.every((e) => e.input['password'] === '[MASKED]')).toBe(true)
  })

  // Real work, not a cold start: it generates, masks, validates and inserts 200 rows. 0.46 s idle, but 2.4 s with
  // the CPU starved and 5.1 s inside a full parallel run, so it gets its own limit instead of the 5 s default.
  it("stores a project tool's inputs in the database through the same path as real rows", { timeout: 30_000 }, async () => {
    const project = await makeProject('inputs')
    await db.tool.create({
      data: {
        projectId: project.id, operationId: 'loginUser', method: 'GET', path: '/user/login', name: 'loginUser', description: 'Log in',
        specName: 'loginUser', specDescription: 'Log in', inputSchema: loginSchema,
      },
    })
    await seedAnalyticsLogs(db, { projectSlug: project.slug, rows: 200, now: NOW }, LOCAL)
    const rows = await db.toolCallLog.findMany({ where: { projectId: project.id, toolName: 'loginUser', errorClass: { not: 'VALIDATION' } } })
    const withInput = rows.filter((r) => Object.keys(r.input as object).length > 0)
    expect(withInput.length).toBeGreaterThan(10)
    expect(withInput.every((r) => (r.input as Record<string, unknown>)['password'] === '[MASKED]')).toBe(true)
  })
})

describe('seeded credentials and contact fields', () => {
  const run = (tools: { id: null; name: string; inputSchema: unknown }[], rows = 800) =>
    buildSeedEvents({ projectId: 'pid', projectSlug: 'slug', tools, rows, now: NOW }).filter((e) => e.kind === 'TOOL_CALL' && e.errorClass !== 'VALIDATION' && Object.keys(e.input).length > 0)
  const str = { type: 'string' }
  const int = { type: 'integer' }

  it('Petstore loginUser (both parameters optional) never sends a password without a username', () => {
    const calls = run([{ id: null, name: 'loginUser', inputSchema: { type: 'object', properties: { password: str, username: str } } }])
    const withPassword = calls.filter((e) => 'password' in e.input)
    expect(withPassword.length).toBeGreaterThan(20)
    for (const e of withPassword) expect(typeof e.input['username']).toBe('string')
    expect(calls.some((e) => !('password' in e.input))).toBe(true) // optional parameters still vary
  })

  it("createUser's real property order pairs the password with username, never with email or userStatus", () => {
    const createUser = {
      type: 'object',
      properties: { id: int, email: str, phone: str, lastName: str, password: str, username: str, firstName: str, userStatus: int },
    }
    const calls = run([{ id: null, name: 'createUser', inputSchema: createUser }])
    const withPassword = calls.filter((e) => 'password' in e.input)
    expect(withPassword.length).toBeGreaterThan(20)
    for (const e of withPassword) expect(typeof e.input['username']).toBe('string')
    // email is not forced in by the password: some calls have a password and no email.
    expect(withPassword.some((e) => !('email' in e.input))).toBe(true)
  })

  it('pairs with the first exact identity name: username, then login, then email; string-typed only', () => {
    const only = (properties: Record<string, unknown>) =>
      run([{ id: null, name: 't', inputSchema: { type: 'object', properties: { password: str, ...properties } } }]).filter((e) => 'password' in e.input)
    for (const e of only({ email: str, login: str })) expect(typeof e.input['login']).toBe('string')
    for (const e of only({ email: str })) expect(typeof e.input['email']).toBe('string')
    for (const e of only({ user_name: str, login: str })) expect(typeof e.input['user_name']).toBe('string')
    for (const e of only({ USERNAME: str })) expect(typeof e.input['USERNAME']).toBe('string')
    // userStatus and userId are not identity names, and an integer "username" is not string-typed.
    const none = only({ userStatus: int, userId: int, username: int })
    expect(none.length).toBeGreaterThan(20)
    expect(none.some((e) => !('userStatus' in e.input))).toBe(true)
    expect(none.some((e) => !('userId' in e.input))).toBe(true)
    expect(none.some((e) => !('username' in e.input))).toBe(true)
  })

  it('email and phone look real: <username>@example.com and a fictional 555-01xx number, same every run', () => {
    const schema = { type: 'object', properties: { email: str, phone: str, username: str } }
    const calls = run([{ id: null, name: 'createUser', inputSchema: schema }])
    const withEmail = calls.filter((e) => 'email' in e.input)
    const withPhone = calls.filter((e) => 'phone' in e.input)
    expect(withEmail.length).toBeGreaterThan(20)
    expect(withPhone.length).toBeGreaterThan(20)
    for (const e of withEmail) {
      expect(e.input['email']).toMatch(/^[a-z]+@example\.com$/)
      if ('username' in e.input) expect(e.input['email']).toBe(`${e.input['username']}@example.com`)
    }
    for (const e of withPhone) expect(e.input['phone']).toMatch(/^\+1-555-01\d\d$/)
    expect(run([{ id: null, name: 'createUser', inputSchema: schema }])).toEqual(calls)
  })
})

describe('seeded VALIDATION rows', () => {
  const str = { type: 'string' }
  const tools = [
    { id: null, name: 'getPet', inputSchema: { type: 'object', properties: { petId: { type: 'integer', minimum: 1, maximum: 9 }, note: str }, required: ['petId'] } },
    { id: null, name: 'login', inputSchema: { type: 'object', properties: { username: str, password: str }, required: ['username', 'password'] } },
    { id: null, name: 'listPets', inputSchema: { type: 'object', properties: { limit: { type: 'integer' }, tag: str, mode: { type: 'string', enum: ['a', 'b'] } } } },
    { id: null, name: 'ping', inputSchema: { type: 'object', properties: {} } },
  ]
  const events = buildSeedEvents({ projectId: 'pid', projectSlug: 'slug', tools, rows: 4000, now: NOW })
  const validation = events.filter((e) => e.errorClass === 'VALIDATION')

  it('every error message matches the input that was stored', () => {
    expect(validation.length).toBeGreaterThan(30)
    const kinds = new Set<string>()
    for (const e of validation) {
      const missing = /^Invalid arguments for "(\w+)": data must have required property '(\w+)'$/.exec(e.errorMessage ?? '')
      const wrongType = /^Invalid arguments for "(\w+)": data\/(\w+) must be (\w+)$/.exec(e.errorMessage ?? '')
      expect(missing ?? wrongType).not.toBeNull()
      if (missing) {
        expect(missing[1]).toBe(e.toolName)
        expect(e.input).not.toHaveProperty(missing[2]!)
        kinds.add('missing')
      } else {
        expect(wrongType![1]).toBe(e.toolName)
        const value = e.input[wrongType![2]!]
        expect(value).toBeDefined()
        expect(typeof value === 'number' ? 'number' : typeof value).not.toBe(wrongType![3] === 'integer' ? 'number' : wrongType![3])
        kinds.add('type')
      }
    }
    expect(kinds).toEqual(new Set(['missing', 'type']))
    expect(validation.some((e) => Object.keys(e.input).length > 0)).toBe(true)
  })

  it('a tool with nothing to get wrong never has a VALIDATION row, and enum fields are never the wrong-typed one', () => {
    expect(validation.some((e) => e.toolName === 'ping')).toBe(false)
    expect(validation.some((e) => e.toolName === 'listPets' && /\/mode /.test(e.errorMessage ?? ''))).toBe(false)
  })

  it('goes through the masker like every other row', () => {
    const login = validation.filter((e) => e.toolName === 'login' && 'password' in e.input)
    expect(login.length).toBeGreaterThan(0)
    expect(login.every((e) => e.input['password'] === '[MASKED]')).toBe(true)
    expect(JSON.stringify(validation)).not.toMatch(/-Pw!/)
  })
})
