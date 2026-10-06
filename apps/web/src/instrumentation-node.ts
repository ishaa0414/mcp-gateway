import { loadRootEnv } from '@/lib/root-env'
import { env } from '@/lib/env'

// Next.js only loads .env from apps/web, so the monorepo root .env is loaded
// here. register() finishes before any request is served, and the middleware
// sandbox reads this same process.env, so this one call covers pages, route
// handlers, server actions and middleware in both `next dev` and `next start`.
// Calling loadEnvConfig from next.config.ts instead does NOT work: that only
// mutates the CLI process, not the server runtime.
loadRootEnv()

try {
  env()
} catch (err) {
  // Without this, `next start` logs the error and keeps serving 500s.
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
}
