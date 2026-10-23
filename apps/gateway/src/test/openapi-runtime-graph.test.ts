/**
 * The gateway builds requests and agent schemas; it never reads a spec. The main entry of openapi-tools also parses specs
 * (swagger-parser, YAML), and loading it costs about 250 files and half a second at startup. So the gateway imports the
 * `@mcp-gateway/openapi-tools/runtime` subpath, and nothing on that subpath's import graph may need a package.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { externalImports, reachable as reachableFrom } from './module-graph.js'

const REPO = resolve(__dirname, '../../../..')
const TOOLS_DIST = join(REPO, 'packages/openapi-tools/dist')
const reachable = (entry: string) => reachableFrom(entry, TOOLS_DIST)

describe('the gateway loads only the openapi-tools runtime', () => {
  it('every gateway source file imports the /runtime subpath, never the main entry', () => {
    const offenders: string[] = []
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name)
        if (entry.isDirectory()) {
          if (entry.name !== 'test' && entry.name !== 'node_modules') walk(path)
        } else if (/\.ts$/.test(entry.name) && !/\.test\.ts$/.test(entry.name)) {
          // A quote straight after the package name is the main entry; `/runtime'` is the subpath.
          if (/['"]@mcp-gateway\/openapi-tools['"]/.test(readFileSync(path, 'utf8'))) offenders.push(path.slice(REPO.length + 1).replaceAll('\\', '/'))
        }
      }
    }
    walk(join(REPO, 'apps/gateway/src'))
    expect(offenders).toEqual([])
  })

  it('the runtime entry reaches request building, the request map and the agent schema, and no spec parsing', () => {
    const graph = reachable(join(TOOLS_DIST, 'runtime.js'))
    expect(graph).toEqual(expect.arrayContaining(['runtime.js', 'request-build.js', 'request-map.js', 'agent-schema.js']))
    expect(graph).not.toContain('parse.js')
    for (const file of graph.filter((f) => f.endsWith('.js'))) expect(externalImports(join(TOOLS_DIST, file)), file).toEqual([])
  })

  it('the main entry does reach the parser (so the check above is not vacuous)', () => {
    const graph = reachable(join(TOOLS_DIST, 'index.js'))
    expect(graph).toContain('parse.js')
    expect(externalImports(join(TOOLS_DIST, 'parse.js'))).toEqual(expect.arrayContaining(['@apidevtools/swagger-parser', 'yaml']))
  })

  it('the subpath exports what the gateway uses', async () => {
    const runtime = (await import('@mcp-gateway/openapi-tools/runtime')) as Record<string, unknown>
    for (const name of ['buildRequest', 'RequestBuildError', 'buildRequestMap', 'toAgentSchema']) expect(runtime, name).toHaveProperty(name)
    expect(runtime).not.toHaveProperty('parseSpec')
  })
})
