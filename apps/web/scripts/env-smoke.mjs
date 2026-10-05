#!/usr/bin/env node
/**
 * Smoke test: verifies that loadEnvConfig() can load DATABASE_URL from a root
 * .env file when DATABASE_URL is NOT present in the shell environment.
 *
 * This mirrors exactly what apps/web/next.config.ts does at server startup.
 * Run from the apps/web/ directory (so @next/env resolves from node_modules there).
 *
 * CI usage:
 *   # Write root .env, then verify it loads correctly without a shell var
 *   printf 'DATABASE_URL=%s\n' "$DATABASE_URL" > ../../.env
 *   unset DATABASE_URL
 *   node scripts/env-smoke.mjs
 */
// @next/env is CommonJS — use default import to avoid "named export not found" in Node ESM
import pkg from '@next/env'
const { loadEnvConfig } = pkg
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
// apps/web/scripts/ → apps/web/ → apps/ → repo root
const repoRoot = resolve(__dirname, '../../..')

loadEnvConfig(repoRoot)

if (!process.env['DATABASE_URL']) {
  console.error('SMOKE FAIL: DATABASE_URL not loaded after loadEnvConfig(repoRoot).')
  console.error(`  Looked for root .env at: ${repoRoot}`)
  console.error('  Ensure apps/web/next.config.ts calls loadEnvConfig(resolve(process.cwd(), "../..")).')
  process.exit(1)
}

console.log('SMOKE PASS: DATABASE_URL loaded from root .env successfully.')
