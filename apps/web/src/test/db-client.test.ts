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
    const db = await freshDb()
    const counts = await db.$transaction(async (tx) => {
      const a = await tx.user.count()
      const b = await tx.user.count()
      return [a, b]
    })
    expect(counts[0]).toBe(counts[1])
    await db.$disconnect()
  })
})
