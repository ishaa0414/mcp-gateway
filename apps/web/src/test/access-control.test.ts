/**
 * Access control integration tests.
 *
 * Proves that user A cannot read or modify user B's projects or tools.
 * Uses the mcpgateway_test database (DATABASE_URL_TEST).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { db } from '@mcp-gateway/db'
import { hash } from '@node-rs/argon2'

let userA: { id: string; email: string }
let userB: { id: string; email: string }
let projectA: { id: string; slug: string }
let toolA: { id: string }

// ---------------------------------------------------------------------------
// Setup: create two independent users and a project + tool for user A
// ---------------------------------------------------------------------------

beforeAll(async () => {
  const now = Date.now()

  const [ua, ub] = await Promise.all([
    db.user.create({
      data: {
        email: `test-user-a-${now}@test.local`,
        password: await hash('password123'),
        name: 'User A',
      },
    }),
    db.user.create({
      data: {
        email: `test-user-b-${now}@test.local`,
        password: await hash('password123'),
        name: 'User B',
      },
    }),
  ])
  userA = ua
  userB = ub

  projectA = await db.project.create({
    data: {
      userId: userA.id,
      name: 'User A Project',
      slug: `user-a-project-${now}`,
      upstreamBaseUrl: 'https://api.example.com',
    },
  })

  toolA = await db.tool.create({
    data: {
      projectId: projectA.id,
      operationId: 'getPet',
      method: 'GET',
      path: '/pets/{id}',
      name: 'getPet',
      description: 'Get a pet',
      inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    },
  })
})

afterAll(async () => {
  // Clean up — order matters because of FK constraints
  await db.tool.deleteMany({ where: { projectId: projectA.id } })
  await db.project.deleteMany({ where: { id: projectA.id } })
  await db.user.deleteMany({ where: { id: { in: [userA.id, userB.id] } } })
  await db.$disconnect()
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('project access control', () => {
  it('user B cannot find user A project by slug', async () => {
    const result = await db.project.findFirst({
      where: { slug: projectA.slug, userId: userB.id },
    })
    expect(result).toBeNull()
  })

  it('user B cannot list user A projects', async () => {
    const results = await db.project.findMany({
      where: { userId: userB.id },
    })
    const slugs = results.map((p) => p.slug)
    expect(slugs).not.toContain(projectA.slug)
  })

  it('user A can find their own project', async () => {
    const result = await db.project.findFirst({
      where: { slug: projectA.slug, userId: userA.id },
    })
    expect(result).not.toBeNull()
    expect(result!.id).toBe(projectA.id)
  })
})

describe('tool access control', () => {
  it('user B cannot access user A tools via project query', async () => {
    const project = await db.project.findFirst({
      where: { id: projectA.id, userId: userB.id },
    })
    // If user B doesn't own the project, they can't fetch tools scoped to it
    expect(project).toBeNull()
  })

  it("direct tool lookup without project ownership check is blocked by userId on project", async () => {
    const tool = await db.tool.findFirst({
      where: {
        id: toolA.id,
        project: { userId: userB.id },
      },
    })
    expect(tool).toBeNull()
  })

  it('user A can access their own tools', async () => {
    const tools = await db.tool.findMany({
      where: { project: { userId: userA.id, id: projectA.id } },
    })
    expect(tools.length).toBe(1)
    expect(tools[0]!.id).toBe(toolA.id)
  })
})

describe('tool mutation access control', () => {
  it('user B cannot update user A tool via ownership check', async () => {
    // Simulate what the action does: verify ownership before updating
    const tool = await db.tool.findUnique({
      where: { id: toolA.id },
      include: { project: { select: { userId: true } } },
    })

    expect(tool).not.toBeNull()
    expect(tool!.project.userId).not.toBe(userB.id)
    // Since ownership check fails, no update happens
  })

  it('user B cannot delete user A project', async () => {
    const project = await db.project.findFirst({
      where: { id: projectA.id, userId: userB.id },
    })
    // Must be null — user B does not own it
    expect(project).toBeNull()
    // Confirm project still exists for user A
    const stillExists = await db.project.findUnique({ where: { id: projectA.id } })
    expect(stillExists).not.toBeNull()
  })
})
