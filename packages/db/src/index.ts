import { PrismaPg } from '@prisma/adapter-pg'
import { PrismaClient } from './generated/client/client.js'

function createPrismaClient(): PrismaClient {
  const connectionString = process.env['DATABASE_URL']
  if (!connectionString) {
    throw new Error(
      'DATABASE_URL is not set. This package does not load .env itself; the app importing it must.\n' +
        '  • web: apps/web/src/instrumentation-node.ts loads the root .env.\n' +
        '  • gateway / worker: src/env.ts in each app loads the root .env.\n' +
        '  • If this appears in the browser console, server-only code was imported into a client component.',
    )
  }
  // The pg default is 10 connections per client. Hosted databases (Neon's free tier, Render) and
  // test runs with many workers need a smaller, explicit cap.
  const poolMax = Number(process.env['DATABASE_POOL_MAX'])
  const adapter = new PrismaPg({
    connectionString,
    ...(Number.isInteger(poolMax) && poolMax > 0 ? { max: poolMax } : {}),
  })
  return new PrismaClient({ adapter })
}

declare global {
  var __prisma: PrismaClient | undefined
}

// One client per process in every environment. globalThis (not a module variable)
// so dev hot reloads reuse it. Creating one per access starts a transaction on one
// client and runs its queries on another ("Transaction not found") and leaks a
// connection pool per call.
function getClient(): PrismaClient {
  return (globalThis.__prisma ??= createPrismaClient())
}

// Lazy proxy: defers PrismaClient creation to first use, so the module can be
// imported during `next build` without DATABASE_URL.
export const db: PrismaClient = new Proxy({} as PrismaClient, {
  get(_target, prop) {
    const client = getClient()
    const value = Reflect.get(client, prop, client)
    return typeof value === 'function' ? value.bind(client) : value
  },
})

export { PrismaClient } from './generated/client/client.js'
export type * from './generated/client/client.js'
