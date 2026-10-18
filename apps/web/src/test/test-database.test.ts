/**
 * Every package's suite has its own database, so one package's table-wide deletes (the log
 * retention tests) cannot remove another package's rows. This guards the naming rule and that the
 * web suite really runs on its own database.
 */
import { describe, expect, it } from 'vitest'
import { db } from '@mcp-gateway/db'
import { testDatabaseUrl } from '@mcp-gateway/db/test-database'

const BASE = 'postgresql://postgres:s%40cret@localhost:5432/mcpgateway_test?schema=public'

describe('testDatabaseUrl', () => {
  it('appends the suite name to the database name and keeps everything else', () => {
    const url = new URL(testDatabaseUrl('gateway', BASE))
    expect(url.pathname).toBe('/mcpgateway_test_gateway')
    expect(url.search).toBe('?schema=public')
    expect(url.password).toBe('s%40cret')
    expect(url.host).toBe('localhost:5432')
  })

  it('gives each suite a different database, and never the base one', () => {
    const names = ['web', 'gateway', 'worker'].map((s) => new URL(testDatabaseUrl(s, BASE)).pathname)
    expect(new Set(names).size).toBe(3)
    expect(names).not.toContain('/mcpgateway_test')
  })

  it('rejects a suite name that is not a plain lower-case word, and a URL without a database', () => {
    for (const bad of ['', 'Web', 'a-b', 'a/b', 'web;drop', '1web']) expect(() => testDatabaseUrl(bad, BASE)).toThrow(/Invalid test suite/)
    expect(() => testDatabaseUrl('web', 'postgresql://u:p@localhost:5432/')).toThrow(/must name a database/)
  })
})

describe('the web suite', () => {
  it('runs on mcpgateway_test_web', async () => {
    const [row] = await db.$queryRaw<{ name: string }[]>`SELECT current_database() AS name`
    expect(row!.name).toBe(new URL(testDatabaseUrl('web')).pathname.slice(1))
  })
})
