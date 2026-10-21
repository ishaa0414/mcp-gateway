export {}

// Ensure worker threads use the test DB URL (set by global-setup.ts)
// globalThis.__prisma must be cleared so the db singleton re-initialises with the test URL.
globalThis.__prisma = undefined

// Warm the database client once per test file, here, where no test or hook limit applies. Its first use (query
// compiler, first connection) took 0.2 s idle but 3.7 s with the CPU starved (12 busy loops on 4 cores, measured),
// and it used to land inside whichever hook or test touched the database first, against a 5 s or 10 s limit.
//
// The warm-up client is then thrown away. A test file may change how connections are made after this runs (the
// analytics fixtures set PGOPTIONS to a non-UTC session time zone when they are imported), and a pooled
// connection opened here would keep the old settings. The expensive part is process-wide and stays warm; the next
// client is built fresh, with whatever the file set.
const { db } = await import('@mcp-gateway/db')
await db.$queryRaw`SELECT 1`
await db.$disconnect()
globalThis.__prisma = undefined
