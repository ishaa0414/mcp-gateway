/**
 * Which gateway test files use which database. Almost all use the main one; the files that run retention use
 * their own (see retention-database.ts). The scan is what keeps a future test from running a purge where other
 * files keep rows.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { db } from '@mcp-gateway/db'
import { testDatabaseUrl } from '@mcp-gateway/db/test-database'
import { describe, expect, it } from 'vitest'

const nameOf = (url: string) => decodeURIComponent(new URL(url).pathname.slice(1))

describe('the gateway test databases', () => {
  it('this file, like most of the suite, runs on the main gateway database', async () => {
    const [row] = await db.$queryRaw<{ name: string }[]>`SELECT current_database() AS name`
    expect(row!.name).toBe(nameOf(testDatabaseUrl('gateway')))
    expect(row!.name).toBe('mcpgateway_test_gateway')
  })

  it('there is a separate retention database, and the setup published both URLs', () => {
    expect(process.env['GATEWAY_MAIN_DATABASE_URL']).toBe(testDatabaseUrl('gateway'))
    expect(process.env['GATEWAY_RETENTION_DATABASE_URL']).toBe(testDatabaseUrl('gatewayretention'))
    expect(nameOf(testDatabaseUrl('gatewayretention'))).toBe('mcpgateway_test_gatewayretention')
  })

  it('every test file that runs a purge or the retention timer switches to the retention database, and no other file does', () => {
    const files = readdirSync(__dirname).filter((f) => f.endsWith('.test.ts') && f !== 'test-databases.test.ts')
    const runsRetention = files.filter((f) => /purgeOldLogs|startRetention|retentionTiming/.test(readFileSync(join(__dirname, f), 'utf8')))
    // The call on a line of its own: a comment or a string that mentions it must not count.
    const switches = files.filter((f) => /^useRetentionDatabase\(\)$/m.test(readFileSync(join(__dirname, f), 'utf8')))
    expect(runsRetention.sort()).toEqual(['log-direct.test.ts', 'log-retention.test.ts']) // the scan is not vacuous
    expect(switches.sort()).toEqual(runsRetention.sort())
  })
})
