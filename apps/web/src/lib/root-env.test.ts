import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const KEYS = ['ROOT_ENV_TEST_A', 'ROOT_ENV_TEST_B']
let workspace: string
let appDir: string

// @next/env keeps module-level state, so every test gets a fresh copy.
async function load() {
  vi.resetModules()
  return import('./root-env')
}

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), 'root-env-'))
  appDir = join(workspace, 'apps', 'web')
  mkdirSync(appDir, { recursive: true })
  writeFileSync(join(workspace, 'pnpm-workspace.yaml'), 'packages:\n  - apps/*\n')
  for (const k of KEYS) delete process.env[k]
})

afterEach(() => {
  rmSync(workspace, { recursive: true, force: true })
  for (const k of KEYS) delete process.env[k]
  vi.restoreAllMocks()
})

describe('loadRootEnv', () => {
  it('loads the root .env when started from apps/web', async () => {
    writeFileSync(join(workspace, '.env'), 'ROOT_ENV_TEST_A=from-file\n')
    const { loadRootEnv } = await load()

    const { root } = loadRootEnv(appDir)

    expect(root).toBe(workspace)
    expect(process.env['ROOT_ENV_TEST_A']).toBe('from-file')
  })

  it('does nothing and prints nothing when there is no root .env (Vercel/Render)', async () => {
    process.env['ROOT_ENV_TEST_A'] = 'from-platform'
    const spies = (['log', 'info', 'warn', 'error'] as const).map((m) => vi.spyOn(console, m))
    const { loadRootEnv } = await load()

    expect(() => loadRootEnv(appDir)).not.toThrow()

    for (const spy of spies) expect(spy).not.toHaveBeenCalled()
    expect(process.env['ROOT_ENV_TEST_A']).toBe('from-platform')
  })

  it('does nothing when no workspace root exists above the start directory', async () => {
    const lonely = mkdtempSync(join(tmpdir(), 'no-workspace-'))
    try {
      const error = vi.spyOn(console, 'error')
      const { loadRootEnv } = await load()

      expect(loadRootEnv(lonely)).toEqual({ root: null })
      expect(error).not.toHaveBeenCalled()
    } finally {
      rmSync(lonely, { recursive: true, force: true })
    }
  })

  it('lets real environment variables take precedence over the file', async () => {
    process.env['ROOT_ENV_TEST_A'] = 'from-platform'
    writeFileSync(join(workspace, '.env'), 'ROOT_ENV_TEST_A=from-file\nROOT_ENV_TEST_B=only-in-file\n')
    const { loadRootEnv } = await load()

    loadRootEnv(appDir)

    expect(process.env['ROOT_ENV_TEST_A']).toBe('from-platform')
    expect(process.env['ROOT_ENV_TEST_B']).toBe('only-in-file')
  })
})

describe('loadRootEnv called more than once (dev re-registration)', () => {
  it('does not delete variables that were set after the first call', async () => {
    writeFileSync(join(workspace, '.env'), 'ROOT_ENV_TEST_B=only-in-file\n')
    const { loadRootEnv } = await load()

    loadRootEnv(appDir)
    process.env['ROOT_ENV_TEST_A'] = 'set-later-by-platform'
    loadRootEnv(appDir)

    expect(process.env['ROOT_ENV_TEST_A']).toBe('set-later-by-platform')
    expect(process.env['ROOT_ENV_TEST_B']).toBe('only-in-file')
  })
})

describe('findWorkspaceRoot', () => {
  it('finds the nearest ancestor with pnpm-workspace.yaml', async () => {
    const { findWorkspaceRoot } = await load()
    expect(findWorkspaceRoot(appDir)).toBe(workspace)
    expect(findWorkspaceRoot(workspace)).toBe(workspace)
  })
})
