import { purgeOldLogs, type PrismaClient } from '@mcp-gateway/db'
import type { Logger } from '../config.js'

export interface RetentionOptions {
  days: number
  /** Wait this long after start before the first run (a little more, at random, so instances do not all run together). */
  firstRunDelayMs: number
  intervalMs: number
}

export const DEFAULT_RETENTION_TIMING = { firstRunDelayMs: 60_000, intervalMs: 6 * 60 * 60 * 1000 }

/**
 * Direct mode has no worker, so the gateway deletes old call logs itself: once shortly after it
 * starts (a host that sleeps when idle may never stay up for the full interval, but it also
 * writes no logs while asleep, so a run at wake-up is enough), then every `intervalMs`.
 *
 * Safe with several instances: the delete is idempotent and batched. A failed run is logged and
 * the next one tries again; runs never overlap; the timers do not keep the process alive.
 */
export function startRetention(db: PrismaClient, log: Logger, options: RetentionOptions): { stop(): void } {
  let running = false

  const run = async () => {
    if (running) return
    running = true
    try {
      const deleted = await purgeOldLogs(db, { days: options.days })
      if (deleted > 0) log.info({ deleted, days: options.days }, 'deleted old call logs')
    } catch (err) {
      log.warn({ err: err instanceof Error ? err.message : String(err) }, 'could not delete old call logs; will retry next time')
    } finally {
      running = false
    }
  }

  let interval: NodeJS.Timeout | undefined
  const first = setTimeout(() => {
    void run()
    interval = setInterval(() => void run(), options.intervalMs)
    interval.unref()
  }, options.firstRunDelayMs * (1 + Math.random() * 0.5))
  first.unref()

  return {
    stop() {
      clearTimeout(first)
      if (interval) clearInterval(interval)
    },
  }
}
