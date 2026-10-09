// Startup guard. Importing the gateway's module graph can be slow, and an import or
// startup error must never leave the process silently idle. This module has no heavy
// imports on purpose: it runs before anything else is loaded.

export interface StartupOptions {
  /** Loads and starts the gateway; resolves once it is listening. */
  start: () => Promise<unknown>
  timeoutMs: number
  log: (message: string) => void
  exit: (code: number) => void
}

export function describeError(err: unknown): string {
  if (err instanceof Error) return err.stack ?? err.message
  return String(err)
}

export async function runStartup({ start, timeoutMs, log, exit }: StartupOptions): Promise<void> {
  const watchdog = setTimeout(() => {
    log(
      `Gateway did not start listening within ${Math.round(timeoutMs / 1000)}s. ` +
        'It is stuck loading modules or waiting on an external service. Exiting.',
    )
    exit(1)
  }, timeoutMs)

  try {
    await start()
  } catch (err) {
    log(`Gateway failed to start: ${describeError(err)}`)
    exit(1)
  } finally {
    clearTimeout(watchdog)
  }
}
