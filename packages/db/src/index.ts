import { PrismaPg } from '@prisma/adapter-pg'
import { PrismaClient } from './generated/client/client.js'

/**
 * How long the pool waits to open a connection (or, when it is full, to get a free one) before the query fails.
 * pg's own default is no limit, so a database that accepts connections and never answers hangs the caller for
 * good, and a host that drops packets takes the operating system's own timeout (21 s on Windows). 5 s covers a
 * cold start of a suspended hosted database (Neon's free tier wakes in a few seconds); the worker, which nobody
 * waits on, sets 10 s.
 */
export const DEFAULT_CONNECT_TIMEOUT_MS = 5_000

const positiveInt = (value: string | undefined): number | undefined => {
  const n = Number(value)
  return Number.isInteger(n) && n > 0 ? n : undefined
}

/** DATABASE_CONNECT_TIMEOUT_MS when it is a positive whole number, otherwise the default. */
export function connectTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  return positiveInt(env['DATABASE_CONNECT_TIMEOUT_MS']) ?? DEFAULT_CONNECT_TIMEOUT_MS
}

export function createPrismaClient(env: NodeJS.ProcessEnv = process.env): PrismaClient {
  const connectionString = env['DATABASE_URL']
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
  const poolMax = positiveInt(env['DATABASE_POOL_MAX'])
  const adapter = new PrismaPg({
    connectionString,
    ...(poolMax !== undefined ? { max: poolMax } : {}),
    connectionTimeoutMillis: connectTimeoutMs(env),
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

export { writeLogBatch } from './log-store.js'
export type { WriteLogResult } from './log-store.js'
export { purgeOldLogs } from './log-retention.js'
export { PrismaClient, Prisma } from './generated/client/client.js'
export type * from './generated/client/client.js'
