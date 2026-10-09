// Entry point. Kept tiny: the real startup lives in main.ts and is loaded dynamically so
// that a slow or failing import is reported (and bounded by a timeout) instead of silent.
import { runStartup } from './startup.js'

const timeoutSeconds = Number(process.env.GATEWAY_STARTUP_TIMEOUT_SECONDS)

await runStartup({
  start: () => import('./main.js'),
  timeoutMs: (Number.isFinite(timeoutSeconds) && timeoutSeconds > 0 ? timeoutSeconds : 60) * 1000,
  log: (message) => console.error(`[gateway] ${message}`),
  exit: (code) => process.exit(code),
})
