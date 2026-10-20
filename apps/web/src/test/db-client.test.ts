import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

afterEach(() => {
  vi.unstubAllEnvs()
  vi.resetModules()
})

// In production the lazy proxy used to build a new PrismaClient on every property
// access: transactions then failed with "Transaction not found" and each call
// leaked a connection pool. Dev (which cached on globalThis) hid it.
async function freshDbFor(nodeEnv: string) {
  vi.resetModules()
  vi.stubEnv('NODE_ENV', nodeEnv)
  globalThis.__prisma = undefined
  return (await import('@mcp-gateway/db')).db
}

// The first PrismaClient built in a worker loads and compiles the query compiler. Measured with the CPU
// starved (12 busy loops on 4 cores): that first build took over 5 s, inside the first test's own 5 s limit,
// and under no load a fraction of a second. Pay it once here, under the hook's own limit, so each test below
// measures only what it is about.
beforeAll(async () => {
  const db = await freshDbFor('development')
  await db.$queryRaw`SELECT 1`
  await db.$disconnect()
}, 60_000)

describe.each(['production', 'development'])('db client (NODE_ENV=%s)', (nodeEnv) => {
  const freshDb = () => freshDbFor(nodeEnv)

  it('is a single client: repeated access returns the same objects', async () => {
    const db = await freshDb()
    expect(db.user).toBe(db.user)
    expect(db.$transaction).toBeTypeOf('function')
    await db.$disconnect()
  })

  // Builds a client, runs a transaction with a commit and a rollback, and checks both: 0.42 s idle, 3.2 s with the CPU
  // starved.
  it('runs an interactive transaction end to end', { timeout: 30_000 }, async () => {
    // Not "two counts agree": other test files insert users into this database at the same time,
    // and a read-committed transaction is allowed to see them. This checks what the old bug broke:
    // every statement of the transaction runs on one connection of one client.
    const db = await freshDb()
    const email = `tx-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}@test.local`
    try {
      const seenInside = await db.$transaction(async (tx) => {
        const created = await tx.user.create({ data: { email } })
        return tx.user.findUnique({ where: { id: created.id } })
      })
      expect(seenInside?.email).toBe(email)
      expect(await db.user.findUnique({ where: { email } })).not.toBeNull() // committed

      const rolledBack = `rb-${email}`
      await expect(
        db.$transaction(async (tx) => {
          await tx.user.create({ data: { email: rolledBack } })
          throw new Error('abort')
        })
      ).rejects.toThrow('abort')
      expect(await db.user.findUnique({ where: { email: rolledBack } })).toBeNull() // rolled back
    } finally {
      await db.user.deleteMany({ where: { email: { in: [email, `rb-${email}`] } } })
      await db.$disconnect()
    }
  })
})
