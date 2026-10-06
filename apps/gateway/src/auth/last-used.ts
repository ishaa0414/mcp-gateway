import type { PrismaClient } from '@mcp-gateway/db'
import type { Logger } from '../config.js'

/**
 * Keeps ApiKey.lastUsedAt roughly current without a database write per call: at most one
 * write per key per interval, per gateway instance, and never on the request's critical
 * path. The dashboard only shows it to the minute, so a few minutes of lag is fine.
 */
export class LastUsedTracker {
  private readonly lastWrite = new Map<string, number>()

  constructor(
    private readonly db: PrismaClient,
    private readonly intervalMs: number,
    private readonly log: Logger,
    private readonly now: () => number = Date.now
  ) {}

  touch(apiKeyId: string): void {
    const now = this.now()
    const previous = this.lastWrite.get(apiKeyId)
    if (previous !== undefined && now - previous < this.intervalMs) return
    this.lastWrite.set(apiKeyId, now)

    void this.db.apiKey
      .update({ where: { id: apiKeyId }, data: { lastUsedAt: new Date(now) } })
      .catch((err: unknown) => {
        // Most likely the key was deleted in the meantime. Let a later call retry.
        this.lastWrite.delete(apiKeyId)
        this.log.warn({ apiKeyId, err: err instanceof Error ? err.message : String(err) }, 'could not update lastUsedAt')
      })
  }
}
