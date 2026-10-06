import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { EnvValidationError, validateEnv } from './env.js'

const schema = z.object({
  DATABASE_URL: z.string().min(1),
  AUTH_SECRET: z.string().min(32, 'must be at least 32 characters'),
  PORT: z.coerce.number().int().default(4000),
})

function parse(source: Record<string, string | undefined>) {
  return validateEnv({ schema, appName: 'web', envFile: '.env', source })
}

describe('validateEnv', () => {
  it('returns parsed values and applies defaults', () => {
    const env = parse({
      DATABASE_URL: 'postgresql://localhost:5432/db',
      AUTH_SECRET: 'x'.repeat(32),
    })

    expect(env.DATABASE_URL).toBe('postgresql://localhost:5432/db')
    expect(env.PORT).toBe(4000)
  })

  it('coerces numeric strings', () => {
    const env = parse({
      DATABASE_URL: 'postgresql://localhost:5432/db',
      AUTH_SECRET: 'x'.repeat(32),
      PORT: '8080',
    })

    expect(env.PORT).toBe(8080)
  })

  it('reports every problem in one error, not just the first', () => {
    expect(() => parse({})).toThrow(EnvValidationError)

    try {
      parse({})
    } catch (err) {
      const e = err as EnvValidationError
      expect(e.issues).toHaveLength(2)
      expect(e.issues).toContain('DATABASE_URL: missing (not set)')
      expect(e.issues).toContain('AUTH_SECRET: missing (not set)')
    }
  })

  it('distinguishes an unset variable from an invalid one', () => {
    try {
      parse({ AUTH_SECRET: 'too-short' })
    } catch (err) {
      const e = err as EnvValidationError
      expect(e.issues).toContain('DATABASE_URL: missing (not set)')
      expect(e.issues).toContain('AUTH_SECRET: must be at least 32 characters')
    }
  })

  it('names the app and the file the variables were expected in', () => {
    try {
      parse({})
    } catch (err) {
      const message = (err as Error).message
      expect(message).toContain('[web]')
      expect(message).toContain('.env')
      expect(message).toContain('2 problems')
    }
  })

  it('singularizes the problem count for a single failure', () => {
    try {
      parse({ DATABASE_URL: 'postgresql://localhost:5432/db' })
    } catch (err) {
      expect((err as Error).message).toContain('1 problem:')
    }
  })

  it('treats an empty string as present but invalid', () => {
    try {
      parse({ DATABASE_URL: '', AUTH_SECRET: 'x'.repeat(32) })
    } catch (err) {
      const e = err as EnvValidationError
      expect(e.issues.some((i) => i.startsWith('DATABASE_URL:'))).toBe(true)
      expect(e.issues).not.toContain('DATABASE_URL: missing (not set)')
    }
  })
})
