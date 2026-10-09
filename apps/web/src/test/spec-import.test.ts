/**
 * Spec import integration tests (test database).
 *
 * These exercise the full cycle import -> user edit -> re-import through real
 * Postgres. The earlier unit tests fed `mergeTools` hand-built objects, so they
 * never saw what the database actually returns (e.g. JSONB reordering schema
 * keys) or that nothing persisted the fact that a user had edited a tool.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { db } from '@mcp-gateway/db'
import { importSpec } from '@/lib/spec-import'

const PUBLIC_HOST = '93.184.216.34' // IP literal: no DNS needed, and not private

let userId: string
const createdUsers: string[] = []

function makeSpec(
  overrides: { servers?: unknown; version?: string; ops?: Record<string, unknown> } = {}
): string {
  const idParam = { name: 'petId', in: 'path', required: true, schema: { type: 'integer' } }
  const defaults: Record<string, unknown> = {
    '/pets': {
      get: { operationId: 'listPets', summary: 'List pets', responses: { '200': { description: 'ok' } } },
      post: {
        operationId: 'addPet',
        summary: 'Add a pet',
        requestBody: {
          content: {
            'application/json': {
              schema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
            },
          },
        },
        responses: { '200': { description: 'ok' } },
      },
    },
    '/pets/{petId}': {
      get: { operationId: 'getPetById', summary: 'Find pet by ID', parameters: [idParam], responses: { '200': { description: 'ok' } } },
      delete: { operationId: 'deletePet', summary: 'Delete a pet', parameters: [idParam], responses: { '200': { description: 'ok' } } },
    },
  }
  return JSON.stringify({
    openapi: '3.0.3',
    info: { title: 'Pets', version: overrides.version ?? '1.0.0' },
    ...(overrides.servers !== undefined ? { servers: overrides.servers } : {}),
    paths: overrides.ops ?? defaults,
  })
}

async function newProject(upstreamBaseUrl = '') {
  return db.project.create({
    data: {
      userId,
      name: 'Import test',
      slug: `import-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      upstreamBaseUrl,
    },
  })
}

const toolByOp = (projectId: string, operationId: string) =>
  db.tool.findUniqueOrThrow({ where: { projectId_operationId: { projectId, operationId } } })

beforeAll(async () => {
  const user = await db.user.create({ data: { email: `import-${Date.now()}@test.local`, name: 'Importer' } })
  userId = user.id
  createdUsers.push(user.id)
})

afterAll(async () => {
  await db.user.deleteMany({ where: { id: { in: createdUsers } } })
})

describe('first import', () => {
  it('creates a tool per operation with the spec as its baseline', async () => {
    const p = await newProject()
    const summary = await importSpec(db, { projectId: p.id, specText: makeSpec() })

    expect(summary).toMatchObject({ added: 4, updated: 0, removed: 0, unchanged: 0, total: 4 })
    const tool = await toolByOp(p.id, 'getPetById')
    expect(tool).toMatchObject({ name: 'getPetById', specName: 'getPetById', enabled: true })
    expect(tool.specDescription).toBe(tool.description)
  })
})

describe('re-importing an identical spec', () => {
  it('reports 0 updated and counts every tool as unchanged', async () => {
    const p = await newProject()
    await importSpec(db, { projectId: p.id, specText: makeSpec() })

    const again = await importSpec(db, { projectId: p.id, specText: makeSpec() })

    // Regression: this used to report "N updated" because Postgres JSONB returns
    // schema keys in a different order than they were written.
    expect(again).toMatchObject({ added: 0, updated: 0, removed: 0, unchanged: 4, total: 4 })
  })

  it('keeps every user edit: name, description, enabled and hidden params', async () => {
    const p = await newProject()
    await importSpec(db, { projectId: p.id, specText: makeSpec() })

    const before = await toolByOp(p.id, 'getPetById')
    await db.tool.update({
      where: { id: before.id },
      data: {
        name: 'find_pet',
        description: 'Look up one pet by its id',
        enabled: false,
        hiddenParams: { petId: { value: 7, required: true } },
      },
    })

    const again = await importSpec(db, { projectId: p.id, specText: makeSpec() })

    const after = await toolByOp(p.id, 'getPetById')
    expect(after).toMatchObject({
      name: 'find_pet',
      description: 'Look up one pet by its id',
      enabled: false,
      hiddenParams: { petId: { value: 7, required: true } },
    })
    expect(again.updated).toBe(0)
  })

  it('survives repeated re-imports', async () => {
    const p = await newProject()
    await importSpec(db, { projectId: p.id, specText: makeSpec() })
    const t = await toolByOp(p.id, 'listPets')
    await db.tool.update({ where: { id: t.id }, data: { name: 'all_pets' } })

    for (let i = 0; i < 3; i++) await importSpec(db, { projectId: p.id, specText: makeSpec() })

    expect((await toolByOp(p.id, 'listPets')).name).toBe('all_pets')
  })
})

describe('re-importing a changed spec', () => {
  it('updates spec-derived fields but not user-edited ones', async () => {
    const p = await newProject()
    await importSpec(db, { projectId: p.id, specText: makeSpec() })
    const edited = await toolByOp(p.id, 'getPetById')
    await db.tool.update({ where: { id: edited.id }, data: { name: 'find_pet' } })

    const changedOps = JSON.parse(makeSpec()).paths
    changedOps['/pets/{petId}'].get.summary = 'Fetch a single pet'
    changedOps['/pets/{petId}'].delete.summary = 'Remove a pet'
    const summary = await importSpec(db, { projectId: p.id, specText: makeSpec({ ops: changedOps }) })

    expect(summary).toMatchObject({ added: 0, updated: 2, removed: 0, unchanged: 2 })
    // Name was edited and is kept; the description was not edited and follows the spec.
    expect(await toolByOp(p.id, 'getPetById')).toMatchObject({
      name: 'find_pet',
      description: 'Fetch a single pet',
      specName: 'getPetById',
    })
    expect(await toolByOp(p.id, 'deletePet')).toMatchObject({ description: 'Remove a pet' })
  })

  it('soft-removes operations that left the spec, keeping their edits, and restores them', async () => {
    const p = await newProject()
    await importSpec(db, { projectId: p.id, specText: makeSpec() })
    const t = await toolByOp(p.id, 'deletePet')
    await db.tool.update({ where: { id: t.id }, data: { name: 'nuke_pet', enabled: false } })

    const withoutDelete = JSON.parse(makeSpec()).paths
    delete withoutDelete['/pets/{petId}'].delete
    const removedRun = await importSpec(db, { projectId: p.id, specText: makeSpec({ ops: withoutDelete }) })
    expect(removedRun).toMatchObject({ removed: 1, total: 3 })
    expect(await toolByOp(p.id, 'deletePet')).toMatchObject({ name: 'nuke_pet', enabled: false })
    expect((await toolByOp(p.id, 'deletePet')).removedAt).not.toBeNull()

    const restoredRun = await importSpec(db, { projectId: p.id, specText: makeSpec() })
    expect(restoredRun).toMatchObject({ updated: 1, removed: 0 })
    expect(await toolByOp(p.id, 'deletePet')).toMatchObject({ name: 'nuke_pet', enabled: false, removedAt: null })
  })

  it('writes method and path changes (they were previously ignored on update)', async () => {
    const p = await newProject()
    await importSpec(db, { projectId: p.id, specText: makeSpec() })

    const moved = JSON.parse(makeSpec()).paths
    moved['/animals'] = moved['/pets']
    delete moved['/pets']
    await importSpec(db, { projectId: p.id, specText: makeSpec({ ops: moved }) })

    expect(await toolByOp(p.id, 'listPets')).toMatchObject({ method: 'GET', path: '/animals' })
  })
})

describe('upstream base URL on import', () => {
  it('resolves a relative servers URL against the spec URL (the Petstore case)', async () => {
    const p = await newProject()
    const summary = await importSpec(db, {
      projectId: p.id,
      specText: makeSpec({ servers: [{ url: '/api/v3' }] }),
      specUrl: `https://${PUBLIC_HOST}/api/v3/openapi.json`,
    })

    expect(summary.baseUrl).toEqual({ status: 'set', url: `https://${PUBLIC_HOST}/api/v3` })
    expect((await db.project.findUniqueOrThrow({ where: { id: p.id } })).upstreamBaseUrl).toBe(
      `https://${PUBLIC_HOST}/api/v3`
    )
  })

  it('leaves the base URL unset for a file import with a relative server, and says so', async () => {
    const p = await newProject()
    const summary = await importSpec(db, { projectId: p.id, specText: makeSpec({ servers: [{ url: '/api/v3' }] }) })

    expect(summary.baseUrl).toEqual({ status: 'unset', reason: 'relative' })
    expect((await db.project.findUniqueOrThrow({ where: { id: p.id } })).upstreamBaseUrl).toBe('')
  })

  it('never stores a relative base URL, whatever the spec says', async () => {
    for (const url of ['/api/v3', 'api/v3', '../v3', '//host/v3']) {
      const p = await newProject()
      await importSpec(db, { projectId: p.id, specText: makeSpec({ servers: [{ url }] }) })
      expect((await db.project.findUniqueOrThrow({ where: { id: p.id } })).upstreamBaseUrl).toBe('')
    }
  })

  it('substitutes server variable defaults', async () => {
    const p = await newProject()
    const servers = [
      { url: `https://${PUBLIC_HOST}:{port}/{base}`, variables: { port: { default: '8443' }, base: { default: 'v2' } } },
    ]
    const summary = await importSpec(db, { projectId: p.id, specText: makeSpec({ servers }) })
    expect(summary.baseUrl).toEqual({ status: 'set', url: `https://${PUBLIC_HOST}:8443/v2` })
  })

  it('reports when the spec declares no servers', async () => {
    const p = await newProject()
    const summary = await importSpec(db, { projectId: p.id, specText: makeSpec() })
    expect(summary.baseUrl).toEqual({ status: 'unset', reason: 'none' })
  })

  it('refuses a private/internal server URL and still imports the tools', async () => {
    for (const url of ['http://127.0.0.1:8080/v1', 'http://169.254.169.254/latest', 'http://10.0.0.5']) {
      const p = await newProject()
      const summary = await importSpec(db, { projectId: p.id, specText: makeSpec({ servers: [{ url }] }) })

      expect(summary.baseUrl).toMatchObject({ status: 'unset', reason: 'rejected' })
      expect(summary.added).toBe(4)
      expect((await db.project.findUniqueOrThrow({ where: { id: p.id } })).upstreamBaseUrl).toBe('')
    }
  })

  it('keeps a base URL the user already set', async () => {
    const mine = `https://${PUBLIC_HOST}/mine`
    const p = await newProject(mine)
    const summary = await importSpec(db, {
      projectId: p.id,
      specText: makeSpec({ servers: [{ url: `https://${PUBLIC_HOST}/theirs` }] }),
    })

    expect(summary.baseUrl).toEqual({ status: 'kept', url: mine })
    expect((await db.project.findUniqueOrThrow({ where: { id: p.id } })).upstreamBaseUrl).toBe(mine)
  })

  it('replaces a relative value left behind by an older import', async () => {
    const p = await newProject('/api/v3')
    const summary = await importSpec(db, {
      projectId: p.id,
      specText: makeSpec({ servers: [{ url: `https://${PUBLIC_HOST}/v1` }] }),
    })
    expect(summary.baseUrl).toEqual({ status: 'set', url: `https://${PUBLIC_HOST}/v1` })
  })
})

describe('tool name collisions', () => {
  const findOp = (operationId: string, path = '/find') => ({
    get: { operationId, summary: 'Find something', responses: { '200': { description: 'ok' } } },
    path,
  })

  /** The default spec plus extra operations, keyed by path. */
  function specWith(extra: Record<string, unknown>) {
    return makeSpec({ ops: { ...JSON.parse(makeSpec()).paths, ...extra } })
  }

  const namesOf = async (projectId: string) =>
    (await db.tool.findMany({ where: { projectId }, orderBy: { name: 'asc' } })).map((t) => t.name)

  it("keeps the user's name and suffixes a new operation that wants it", async () => {
    const p = await newProject()
    await importSpec(db, { projectId: p.id, specText: makeSpec() })
    const pet = await toolByOp(p.id, 'getPetById')
    await db.tool.update({ where: { id: pet.id }, data: { name: 'find_pet' } })

    const summary = await importSpec(db, {
      projectId: p.id,
      specText: specWith({ '/find': { get: findOp('find_pet').get } }),
    })

    expect(summary.added).toBe(1)
    expect(summary.collisions).toEqual([{ operationId: 'find_pet', wanted: 'find_pet', assigned: 'find_pet_2' }])
    expect((await toolByOp(p.id, 'getPetById')).name).toBe('find_pet')
    expect(await toolByOp(p.id, 'find_pet')).toMatchObject({ name: 'find_pet_2', specName: 'find_pet' })
  })

  it('is stable on the next re-import: nothing updated, no collision reported, no crash', async () => {
    const p = await newProject()
    await importSpec(db, { projectId: p.id, specText: makeSpec() })
    const pet = await toolByOp(p.id, 'getPetById')
    await db.tool.update({ where: { id: pet.id }, data: { name: 'find_pet' } })
    const v2 = specWith({ '/find': { get: findOp('find_pet').get } })
    await importSpec(db, { projectId: p.id, specText: v2 })
    const before = await namesOf(p.id)

    const again = await importSpec(db, { projectId: p.id, specText: v2 })

    expect(again).toMatchObject({ added: 0, updated: 0, removed: 0, unchanged: 5, collisions: [] })
    expect(await namesOf(p.id)).toEqual(before)
  })

  it("never reuses the name of a removed tool", async () => {
    const p = await newProject()
    const v1 = makeSpec({ ops: { '/a': { get: findOp('get_pet').get } } })
    await importSpec(db, { projectId: p.id, specText: v1 })

    // get_pet disappears and a different operation sanitises to the same name.
    const v2 = makeSpec({ ops: { '/b': { get: findOp('get.pet').get } } })
    const summary = await importSpec(db, { projectId: p.id, specText: v2 })

    expect(summary).toMatchObject({ added: 1, removed: 1 })
    expect(summary.collisions).toEqual([{ operationId: 'get.pet', wanted: 'get_pet', assigned: 'get_pet_2' }])
    expect(await toolByOp(p.id, 'get_pet')).toMatchObject({ name: 'get_pet' })
    expect((await toolByOp(p.id, 'get_pet')).removedAt).not.toBeNull()
  })

  it('keeps every name in the project unique after a collision import', async () => {
    const p = await newProject()
    await importSpec(db, { projectId: p.id, specText: makeSpec() })
    for (const op of ['listPets', 'addPet']) {
      const t = await toolByOp(p.id, op)
      await db.tool.update({ where: { id: t.id }, data: { name: `mine_${op}` } })
    }
    await importSpec(db, {
      projectId: p.id,
      specText: specWith({
        '/x': { get: findOp('mine_listPets').get },
        '/y': { get: findOp('mine_addPet').get },
      }),
    })

    const names = await namesOf(p.id)
    expect(new Set(names).size).toBe(names.length)
    expect(names).toEqual(expect.arrayContaining(['mine_listPets', 'mine_listPets_2', 'mine_addPet', 'mine_addPet_2']))
  })
})

describe('database enforces unique tool names per project', () => {
  const tool = (projectId: string, operationId: string, name: string) => ({
    projectId,
    operationId,
    method: 'GET',
    path: `/${operationId}`,
    name,
    description: 'd',
    specName: name,
    specDescription: 'd',
    inputSchema: { type: 'object' },
  })

  it('rejects a second tool with the same name in one project', async () => {
    const p = await newProject()
    await db.tool.create({ data: tool(p.id, 'one', 'dup_name') })

    await expect(db.tool.create({ data: tool(p.id, 'two', 'dup_name') })).rejects.toMatchObject({ code: 'P2002' })
  })

  it('rejects renaming a tool onto another tool name', async () => {
    const p = await newProject()
    await db.tool.create({ data: tool(p.id, 'one', 'taken') })
    const other = await db.tool.create({ data: tool(p.id, 'two', 'free') })

    await expect(db.tool.update({ where: { id: other.id }, data: { name: 'taken' } })).rejects.toMatchObject({
      code: 'P2002',
    })
  })

  it('allows the same name in different projects', async () => {
    const [a, b] = [await newProject(), await newProject()]
    await db.tool.create({ data: tool(a.id, 'one', 'shared') })
    await expect(db.tool.create({ data: tool(b.id, 'one', 'shared') })).resolves.toBeTruthy()
  })

  it('is case-sensitive, like the MCP names it protects', async () => {
    const p = await newProject()
    await db.tool.create({ data: tool(p.id, 'one', 'getPet') })
    await expect(db.tool.create({ data: tool(p.id, 'two', 'getpet') })).resolves.toBeTruthy()
  })
})

// JSONB does not preserve key order, so compare property names as a sorted set.
const propertyNames = (schema: unknown) => Object.keys((schema as { properties: object }).properties).sort()

describe('re-importing an existing project picks up the new argument mapping', () => {
  // `id` is both a path parameter and a body field. The old extractor kept one `id` (the
  // body field won) and lost the other; the new one names them `id` and `body_id`.
  const clashingSpec = JSON.stringify({
    openapi: '3.0.3',
    info: { title: 'T', version: '1' },
    paths: {
      '/things/{id}': {
        put: {
          operationId: 'updateThing',
          summary: 'Update a thing',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }],
          requestBody: {
            content: { 'application/json': { schema: { type: 'object', properties: { id: { type: 'string' }, name: { type: 'string' } } } } },
          },
          responses: { '200': { description: 'ok' } },
        },
      },
    },
  })

  it('rewrites the stored schema of an unchanged operation, keeping the user edits', async () => {
    const p = await newProject()
    await importSpec(db, { projectId: p.id, specText: clashingSpec })
    const tool = await toolByOp(p.id, 'updateThing')
    expect(propertyNames(tool.inputSchema)).toEqual(['body_id', 'id', 'name'])

    // Put the tool back into the shape the previous extractor stored, plus a user edit.
    await db.tool.update({
      where: { id: tool.id },
      data: {
        name: 'update_it',
        enabled: false,
        inputSchema: { type: 'object', properties: { id: { type: 'string' }, name: { type: 'string' } } },
      },
    })

    const summary = await importSpec(db, { projectId: p.id, specText: clashingSpec })

    expect(summary).toMatchObject({ added: 0, updated: 1, removed: 0, unchanged: 0 })
    const after = await toolByOp(p.id, 'updateThing')
    expect(propertyNames(after.inputSchema)).toEqual(['body_id', 'id', 'name'])
    expect(after).toMatchObject({ name: 'update_it', enabled: false })
  })
})
