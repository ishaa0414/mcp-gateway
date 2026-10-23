/**
 * The gateway serves requests; it must not load the analytics seed. The seed helpers live behind
 * `@mcp-gateway/db/seed`, so the main entry of the db package, which the gateway imports, must not reach them.
 * This walks the static import graph of the built main entry and fails if a seed module is on it.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import { reachable as reachableFrom } from './module-graph.js'

const REPO = resolve(__dirname, '../../../..')
const DB_DIST = join(REPO, 'packages/db/dist')
const reachable = (entry: string) => reachableFrom(entry, DB_DIST)
const SEED_NAMES = ['seedAnalyticsLogs', 'assertSeedAllowed', 'buildSeedEvents', 'SeedRefusedError', 'DEFAULT_SEED_ROWS', 'MAX_SEED_ROWS', 'FALLBACK_SEED_TOOLS', 'createRandom', 'sampleInvalidInput']

describe('the gateway does not load the analytics seed', () => {
  it('no seed module is reachable from the main entry of the db package', () => {
    const graph = reachable(join(DB_DIST, 'index.js'))
    expect(graph).toContain('index.js')
    expect(graph).toContain('log-store.js') // the walk follows real imports (it is not vacuous)
    expect(graph.filter((f) => /seed/i.test(f))).toEqual([])
  })

  it('the main entry exports none of the seed helpers', async () => {
    const main = (await import(pathToFileURL(join(DB_DIST, 'index.js')).href)) as Record<string, unknown>
    for (const name of SEED_NAMES) expect(main, name).not.toHaveProperty(name)
  })

  it('the seed subpath has them, and its graph is where the seed code is', async () => {
    const seed = (await import('@mcp-gateway/db/seed')) as Record<string, unknown>
    for (const name of SEED_NAMES) expect(seed, name).toHaveProperty(name)
    expect(reachable(join(DB_DIST, 'seed.js')).filter((f) => /seed/i.test(f))).toEqual(expect.arrayContaining(['seed.js', 'analytics-seed.js', 'seed-input.js']))
  })

  it('nothing the gateway or the dashboard ships imports the seed subpath (only tests and the seed script do)', () => {
    const offenders: string[] = []
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name)
        if (entry.isDirectory()) {
          if (entry.name !== 'test' && entry.name !== 'node_modules') walk(path)
        } else if (/\.(ts|tsx)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
          if (readFileSync(path, 'utf8').includes('@mcp-gateway/db/seed')) offenders.push(path.slice(REPO.length + 1).replaceAll('\\', '/'))
        }
      }
    }
    for (const app of ['apps/gateway/src', 'apps/web/src', 'apps/worker/src']) walk(join(REPO, app))
    expect(offenders).toEqual([])
  })
})
