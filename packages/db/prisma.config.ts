import { config as loadEnv } from 'dotenv'
import { resolve } from 'node:path'
import { defineConfig } from 'prisma/config'

// Load root .env for local dev. No-op if the file is missing (CI sets vars directly).
loadEnv({ path: resolve(process.cwd(), '../../.env') })

const databaseUrl = process.env['DATABASE_URL']

export default defineConfig({
  schema: './prisma/schema.prisma',
  // Only set datasource when the URL is available — generate doesn't need it.
  ...(databaseUrl ? { datasource: { url: databaseUrl } } : {}),
  migrations: {
    path: './prisma/migrations',
    seed: 'tsx prisma/seed.ts',
  },
})
