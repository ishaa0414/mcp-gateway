/**
 * The gateway suite has two databases. Almost every file uses the main one (`mcpgateway_test_gateway`). The two
 * files that run retention (`purgeOldLogs`, or the sink's retention timer, which calls it) use
 * `mcpgateway_test_gatewayretention`, because a purge deletes every old row in its table, whoever wrote it. On
 * their own database it can only ever reach rows those two files made.
 *
 * `global-setup.ts` creates both and puts their URLs in the environment. A retention test file calls
 * `useRetentionDatabase()` once, before it first touches the database (the client is created lazily).
 */

const globals = globalThis as { __prisma?: { $disconnect(): Promise<unknown> } | undefined }
const currentClient = () => globals.__prisma // read through a function: TypeScript narrows the property after an assignment

function url(name: 'GATEWAY_MAIN_DATABASE_URL' | 'GATEWAY_RETENTION_DATABASE_URL'): string {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is not set: the gateway test global setup should have set it.`)
  return value
}

/** Point this test file's database client at the retention database. Call it at the top, before any query. */
export function useRetentionDatabase(): void {
  process.env['DATABASE_URL'] = url('GATEWAY_RETENTION_DATABASE_URL')
  globals.__prisma = undefined // the next use builds a client for the new URL
}

/** Run `fn` with the database client pointed at the main gateway database, then put the retention one back. */
export async function withMainDatabase<T>(fn: () => Promise<T>): Promise<T> {
  const retentionClient = currentClient()
  const retentionUrl = process.env['DATABASE_URL']
  process.env['DATABASE_URL'] = url('GATEWAY_MAIN_DATABASE_URL')
  globals.__prisma = undefined
  try {
    return await fn()
  } finally {
    await currentClient()?.$disconnect().catch(() => undefined)
    globals.__prisma = retentionClient
    if (retentionUrl === undefined) delete process.env['DATABASE_URL']
    else process.env['DATABASE_URL'] = retentionUrl
  }
}
