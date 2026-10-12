// Dev only: fill one project with realistic call logs.
//   pnpm db:seed:analytics --project <slug> [--rows 400]
import { config as loadEnv } from 'dotenv'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

const __dirname = fileURLToPath(new URL('.', import.meta.url))
loadEnv({ path: resolve(__dirname, '../../../.env') })

const { values } = parseArgs({ options: { project: { type: 'string' }, rows: { type: 'string' } } })

async function main() {
  // Imported late: the production / host check must run before any database client exists.
  const { assertSeedAllowed, seedAnalyticsLogs, DEFAULT_SEED_ROWS } = await import('../src/analytics-seed.js')
  assertSeedAllowed(process.env)

  if (!values.project) throw new Error('Usage: pnpm db:seed:analytics --project <slug> [--rows N]')
  const rows = values.rows === undefined ? DEFAULT_SEED_ROWS : Number(values.rows)

  const { PrismaPg } = await import('@prisma/adapter-pg')
  const { PrismaClient } = await import('../src/generated/client/client.js')
  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env['DATABASE_URL']! }) })
  try {
    const result = await seedAnalyticsLogs(prisma, { projectSlug: values.project, rows })
    console.log(`Seeded project ${result.projectId}: removed ${result.deleted} old seed rows, wrote ${result.written}.`)
  } finally {
    await prisma.$disconnect()
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})
