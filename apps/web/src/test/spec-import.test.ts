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
