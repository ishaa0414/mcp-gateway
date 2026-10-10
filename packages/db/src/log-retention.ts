import type { PrismaClient } from './generated/client/client.js'

/**
 * Delete log rows older than `days`, in batches so no single statement holds a long lock.
 * Idempotent, so two processes running it at once is harmless. Gives up after `maxBatches`
 * and lets the next run continue, so one run cannot go on forever behind a huge backlog.
 */
export async function purgeOldLogs(
  db: PrismaClient,
  options: { days: number; batchSize?: number; maxBatches?: number; now?: () => number }
): Promise<number> {
  const { days, batchSize = 5000, maxBatches = 200, now = Date.now } = options
  const cutoff = new Date(now() - days * 24 * 60 * 60 * 1000)

  let deleted = 0
  for (let i = 0; i < maxBatches; i++) {
    const count = await db.$executeRaw`
      DELETE FROM tool_call_logs
      WHERE id IN (SELECT id FROM tool_call_logs WHERE created_at < ${cutoff} LIMIT ${batchSize})`
    deleted += count
    if (count < batchSize) break
  }
  return deleted
}
