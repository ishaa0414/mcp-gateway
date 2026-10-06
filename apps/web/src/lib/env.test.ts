import { describe, expect, it } from 'vitest'
import { EnvValidationError } from '@mcp-gateway/shared'
import { parseWebEnv } from './env'

const valid = {
  AUTH_SECRET: 'a'.repeat(32),
  AUTH_URL: 'http://localhost:3000',
  DATABASE_URL: 'postgresql://postgres:postgres@localhost:5432/mcpgateway',
  REDIS_URL: 'redis://localhost:6379',
  ENCRYPTION_KEY: '0'.repeat(64),
}

function issuesFor(source: Record<string, string | undefined>): string[] {
  try {
    parseWebEnv(source)
  } catch (err) {
    if (err instanceof EnvValidationError) return err.issues
    throw err
  }
  throw new Error('expected parseWebEnv to throw')
}

describe('parseWebEnv', () => {
  it('accepts a complete environment', () => {
    const env = parseWebEnv(valid)
    expect(env.AUTH_URL).toBe('http://localhost:3000')
    expect(env.NODE_ENV).toBe('development')
  })

  it('rejects Auth.js v4 variable names instead of silently ignoring them', () => {
    const { AUTH_SECRET, AUTH_URL, ...rest } = valid
    const issues = issuesFor({
      ...rest,
      NEXTAUTH_SECRET: AUTH_SECRET,
      NEXTAUTH_URL: AUTH_URL,
    })

    expect(issues).toEqual(['AUTH_SECRET: missing (not set)', 'AUTH_URL: missing (not set)'])
  })

  it('lists every missing variable from an empty environment', () => {
    expect(issuesFor({})).toEqual([
      'AUTH_SECRET: missing (not set)',
      'AUTH_URL: missing (not set)',
      'DATABASE_URL: missing (not set)',
      'REDIS_URL: missing (not set)',
      'ENCRYPTION_KEY: missing (not set)',
    ])
  })

  it('rejects a short AUTH_SECRET', () => {
    expect(issuesFor({ ...valid, AUTH_SECRET: 'ci-secret-not-real' })).toEqual([
      'AUTH_SECRET: must be at least 32 characters (openssl rand -hex 32)',
    ])
  })

  it('rejects a non-hex or wrong-length ENCRYPTION_KEY', () => {
    expect(issuesFor({ ...valid, ENCRYPTION_KEY: 'z'.repeat(64) })).toHaveLength(1)
    expect(issuesFor({ ...valid, ENCRYPTION_KEY: '0'.repeat(63) })).toHaveLength(1)
  })

  it('rejects an AUTH_URL that is not an absolute URL', () => {
    expect(issuesFor({ ...valid, AUTH_URL: '/sign-in' })[0]).toMatch(/^AUTH_URL:/)
  })
})
