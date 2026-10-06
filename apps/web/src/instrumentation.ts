export async function register() {
  // This file is bundled for both runtimes. Node-only code lives in a separate
  // module so the edge bundle never sees `fs` / `node:path`.
  if (process.env['NEXT_RUNTIME'] === 'nodejs') {
    await import('./instrumentation-node')
  }
}
