/**
 * The gateway keys its compiled argument validators by `${tool.id}:${tool.version}` and takes
 * `version` from the tool row's `updatedAt` (apps/gateway/src/cache/project-config.ts). So every way
 * a tool's schema can change must move `updatedAt`, or the gateway would keep checking arguments
 * against the old schema.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { db } from '@mcp-gateway/db'

const session = vi.hoisted(() => ({ userId: '' }))
vi.mock('@/auth', () => ({ auth: async () => ({ user: { id: session.userId } }) }))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))

import { updateTool } from '@/actions/tools'
import { importSpec } from '@/lib/spec-import'

let userId: string
let projectId: string

const spec = (petIdType: string, extraParam = false) =>
  JSON.stringify({
    openapi: '3.0.3',
    info: { title: 'Pets', version: '1' },
    paths: {
      '/pets/{petId}': {
        get: {
          operationId: 'getPetById',
          summary: 'Find pet by ID',
          parameters: [
            { name: 'petId', in: 'path', required: true, schema: { type: petIdType } },
            ...(extraParam ? [{ name: 'verbose', in: 'query', schema: { type: 'boolean' } }] : []),
          ],
          responses: { '200': { description: 'ok' } },
        },
      },
    },
  })

const tool = () => db.tool.findUniqueOrThrow({ where: { projectId_operationId: { projectId, operationId: 'getPetById' } } })
const pause = () => new Promise((r) => setTimeout(r, 5)) // updatedAt has millisecond resolution

beforeAll(async () => {
  const user = await db.user.create({ data: { email: `version-${Date.now()}@test.local`, name: 'Owner' } })
  userId = user.id
  session.userId = user.id
  const project = await db.project.create({ data: { userId, name: 'Version', slug: `version-${Date.now()}`, upstreamBaseUrl: '' } })
  projectId = project.id
  await importSpec(db, { projectId, specText: spec('integer') })
})

afterAll(async () => {
  await db.user.deleteMany({ where: { id: userId } })
})

describe('a tool changes version whenever its validator input changes', () => {
  it('(b) hidden parameters change: updateTool', async () => {
    const before = await tool()
    await pause()
    const res = await updateTool(before.id, { hiddenParams: { petId: { value: 7 } } })
    expect(res.error).toBeUndefined()
    const after = await tool()
    expect(after.hiddenParams).not.toEqual(before.hiddenParams)
    expect(after.updatedAt.getTime()).toBeGreaterThan(before.updatedAt.getTime())
  })

  it('(a) and (c) inputSchema changes through a re-import of a new spec', async () => {
    const before = await tool()
    await pause()
    await importSpec(db, { projectId, specText: spec('string', true) })
    const after = await tool()
    expect(after.inputSchema).not.toEqual(before.inputSchema)
    expect(after.updatedAt.getTime()).toBeGreaterThan(before.updatedAt.getTime())
  })

  it('(c) a re-import of a spec that changes nothing leaves the version alone (cached validators stay valid)', async () => {
    await importSpec(db, { projectId, specText: spec('string', true) })
    const before = await tool()
    await pause()
    await importSpec(db, { projectId, specText: spec('string', true) })
    expect((await tool()).updatedAt.getTime()).toBe(before.updatedAt.getTime())
  })
})
