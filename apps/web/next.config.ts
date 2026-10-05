import type { NextConfig } from 'next'
import { loadEnvConfig } from '@next/env'
import { resolve } from 'node:path'

// Load the monorepo root .env so DATABASE_URL, REDIS_URL, etc. are available
// to all server-side code including workspace packages (e.g. @mcp-gateway/db).
// process.cwd() is apps/web when Next.js starts, so ../../ reaches the repo root.
// override:false (the default) means variables already set in the shell take precedence.
loadEnvConfig(resolve(process.cwd(), '../..'))

const config: NextConfig = {}

export default config
