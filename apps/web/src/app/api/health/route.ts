import { db } from '@/lib/db'

// Unauthenticated so CI can assert the server booted with a working
// DATABASE_URL. Excluded from the middleware matcher in src/middleware.ts.
export const dynamic = 'force-dynamic'

export async function GET() {
  try {
    await db.$queryRaw`SELECT 1`
    return Response.json({ status: 'ok', database: 'ok' })
  } catch (err) {
    console.error('[health] database check failed:', err)
    return Response.json({ status: 'error', database: 'error' }, { status: 503 })
  }
}
