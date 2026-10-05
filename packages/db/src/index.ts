import { config as loadEnv } from 'dotenv'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PrismaPg } from '@prisma/adapter-pg'
import { PrismaClient } from './generated/client/client.js'

// Load root .env for local dev; override:false means shell/CI vars always win.
// Skipped when import.meta.url is not a file:// URL (e.g. Turbopack bundle context during next build).
try {
  const __dirname = fileURLToPath(new URL('.', import.meta.url))
  loadEnv({ path: resolve(__dirname, '../../../.env'), override: false })
} catch {
  // Not a file:// URL — running inside a bundler, env is already provided
}

function createPrismaClient(): PrismaClient {
  const connectionString = process.env['DATABASE_URL']
  if (!connectionString) throw new Error('DATABASE_URL environment variable is not set')
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
// This prevents the module import from throwing when DATABASE_URL is not
// available at build time (e.g. next build page-config collection workers).
export const db: PrismaClient = new Proxy({} as PrismaClient, {
  get(_target, prop) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (getClient() as any)[prop]
  },
})

export { PrismaClient } from './generated/client/client.js'
export type * from './generated/client/client.js'
