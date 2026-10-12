import { randomUUID } from 'node:crypto'
import { db, type Prisma } from '@mcp-gateway/db'

/** A user with one project, and a way to put log rows in it at exact times. */
export async function createOwner(label: string) {
  const stamp = `${label}-${randomUUID().slice(0, 8)}`
  const user = await db.user.create({ data: { email: `an-${stamp}@test.local`, name: label } })
  const project = await db.project.create({
    data: { userId: user.id, name: label, slug: `an-${stamp}`, upstreamBaseUrl: 'https://api.example.com' },
  })
  return { userId: user.id, projectId: project.id, slug: project.slug, scope: { userId: user.id, slug: project.slug } }
}

export async function deleteOwners(...userIds: string[]) {
  await db.user.deleteMany({ where: { id: { in: userIds } } }) // projects and logs cascade
}

export interface LogSpec {
  id: string
  at: string | Date
  tool?: string | null
  ok?: boolean
  latency?: number
  kind?: 'TOOL_CALL' | 'AUTH_FAILURE'
  errorClass?: string | null
  upstreamStatus?: number | null
  input?: Record<string, unknown>
}

export async function insertLogs(projectId: string, specs: LogSpec[]) {
  await db.toolCallLog.createMany({
    data: specs.map((s) => {
      const ok = s.ok ?? true
      return {
        id: s.id,
        projectId,
        kind: s.kind ?? 'TOOL_CALL',
        toolName: s.tool === undefined ? 'listPets' : s.tool,
        input: (s.input ?? {}) as Prisma.InputJsonObject,
        latencyMs: s.latency ?? 100,
        success: ok,
        errorClass: s.errorClass ?? (ok ? null : 'UPSTREAM_5XX'),
        upstreamStatus: s.upstreamStatus === undefined ? (ok ? 200 : 500) : s.upstreamStatus,
        createdAt: new Date(s.at),
      }
    }),
  })
}

/** 2026-10-12 10:00 UTC = 15:30 IST on a Monday. */
export const NOW = new Date('2026-10-12T10:00:00.000Z')
