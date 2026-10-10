import { afterEach, describe, expect, it, vi } from 'vitest'

afterEach(() => {
  vi.unstubAllEnvs()
  vi.resetModules()
})

// In production the lazy proxy used to build a new PrismaClient on every property
// access: transactions then failed with "Transaction not found" and each call
// leaked a connection pool. Dev (which cached on globalThis) hid it.
describe.each(['production', 'development'])('db client (NODE_ENV=%s)', (nodeEnv) => {
  async function freshDb() {
    vi.resetModules()
    vi.stubEnv('NODE_ENV', nodeEnv)
    globalThis.__prisma = undefined
    return (await import('@mcp-gateway/db')).db
  }

  it('is a single client: repeated access returns the same objects', async () => {
    const db = await freshDb()
    expect(db.user).toBe(db.user)
    expect(db.$transaction).toBeTypeOf('function')
    await db.$disconnect()
  })

  it('runs an interactive transaction end to end', async () => {
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
