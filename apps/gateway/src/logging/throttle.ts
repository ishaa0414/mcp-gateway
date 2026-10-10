/**
 * Lets one event per key through per interval, and at most `maxPerInterval` in total.
 *
 * Auth failures and rate-limit rejections can be produced in any number by someone who is not
 * a paying customer (or by a customer who is hammering), and each logged one costs a database
 * row. A dashboard needs to see that it is happening, not every single time. Suppressed events
 * are counted so the gateway can report how many it skipped.
 *
 * Memory is bounded: at most `maxKeys` keys are remembered (the least recently seen is forgotten first).
 */
export class SampleThrottle {
  private readonly lastAllowed = new Map<string, number>()
  private windowStart = Number.NEGATIVE_INFINITY
  private windowCount = 0
  private suppressedTotal = 0

  constructor(
    private readonly intervalMs: number,
    private readonly maxKeys: number,
    private readonly maxPerInterval: number,
    private readonly now: () => number = Date.now
  ) {}

  get suppressed(): number {
    return this.suppressedTotal
  }

  allow(key: string): boolean {
    const t = this.now()

    if (t - this.windowStart >= this.intervalMs) {
      this.windowStart = t
      this.windowCount = 0
    }
    const previous = this.lastAllowed.get(key)
    if ((previous !== undefined && t - previous < this.intervalMs) || this.windowCount >= this.maxPerInterval) {
      this.suppressedTotal++
      return false
    }

    this.windowCount++
    this.lastAllowed.delete(key) // re-insert so the Map's order is least-recently-allowed first
    this.lastAllowed.set(key, t)
    if (this.lastAllowed.size > this.maxKeys) this.lastAllowed.delete(this.lastAllowed.keys().next().value!)
    return true
  }
}
