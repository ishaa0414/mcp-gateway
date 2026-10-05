import { PrismaPg } from '@prisma/adapter-pg'
import { PrismaClient } from './generated/client/client.js'

function createPrismaClient(): PrismaClient {
  const connectionString = process.env['DATABASE_URL']
  if (!connectionString) {
    throw new Error(
      'DATABASE_URL is not set.\n' +
        '  • Next.js: apps/web/next.config.ts must call loadEnvConfig() from @next/env pointing at the repo root.\n' +
        '  • gateway / worker: dotenv loads ../../.env relative to the compiled output (already handled in each app).\n' +
        '  • CI / production: set DATABASE_URL as an environment variable.',
    )
  }
  const adapter = new PrismaPg({ connectionString })
  return new PrismaClient({ adapter })
}

declare global {
  var __prisma: PrismaClient | undefined
}

function getClient(): PrismaClient {
  if (process.env['NODE_ENV'] === 'production') {
    return createPrismaClient()
  }
  return (globalThis.__prisma ??= createPrismaClient())
}

// Lazy proxy: defers PrismaClient creation to first method call.
// This allows the module to be imported during next build without DATABASE_URL.
export const db: PrismaClient = new Proxy({} as PrismaClient, {
  get(_target, prop) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (getClient() as any)[prop]
  },
})

export { PrismaClient } from './generated/client/client.js'
export type * from './generated/client/client.js'
