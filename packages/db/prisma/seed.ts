import { config as loadEnv } from 'dotenv'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = fileURLToPath(new URL('.', import.meta.url))
loadEnv({ path: resolve(__dirname, '../../../.env') })
import { PrismaPg } from '@prisma/adapter-pg'
import { PrismaClient } from '../src/generated/client/client.js'

const adapter = new PrismaPg({ connectionString: process.env['DATABASE_URL']! })
const prisma = new PrismaClient({ adapter })

async function main() {
  const user = await prisma.user.upsert({
    where: { email: 'demo@example.com' },
    update: {},
    create: {
      email: 'demo@example.com',
      name: 'Demo User',
    },
  })

  const project = await prisma.project.upsert({
    where: { slug: 'petstore' },
    update: {},
    create: {
      userId: user.id,
      name: 'Petstore',
      slug: 'petstore',
      upstreamBaseUrl: 'https://petstore3.swagger.io/api/v3',
    },
  })

  console.log('Seed complete:', { userId: user.id, projectId: project.id })
}

main()
  .catch((err) => {
    console.error('Seed failed:', err)
    process.exit(1)
  })
  .finally(() => prisma.$disconnect())
