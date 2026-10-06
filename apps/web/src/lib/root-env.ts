import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { loadEnvConfig, updateInitialEnv } from '@next/env'

/** Walk up from `startDir` to the folder holding pnpm-workspace.yaml, or null. */
export function findWorkspaceRoot(startDir: string): string | null {
  let dir = resolve(startDir)
  for (;;) {
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) return dir
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

/**
 * Load the monorepo root .env into process.env for local development.
 *
 * Does nothing, silently, when there is no workspace root or no .env file, which
 * is the normal case on Vercel/Render where variables come from the platform.
 * Variables already present in process.env always win over the file.
 *
 * forceReload: @next/env caches after its first call and skips work when Next has
 * already processed apps/web's own env files, which would drop the root file.
 * It also treats its first-call snapshot of process.env as "the real environment"
 * and resets to it on every forced reload, so the snapshot is refreshed first;
 * otherwise a variable set after that first call would be deleted.
 */
export function loadRootEnv(startDir: string = process.cwd()): { root: string | null } {
  const root = findWorkspaceRoot(startDir)
  if (root) {
    updateInitialEnv(process.env)
    loadEnvConfig(root, process.env['NODE_ENV'] === 'development', console, true)
  }
  return { root }
}
