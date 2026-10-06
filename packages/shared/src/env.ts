import { z } from 'zod'

export class EnvValidationError extends Error {
  readonly issues: string[]

  constructor(appName: string, envFile: string, issues: string[]) {
    const count = `${issues.length} problem${issues.length === 1 ? '' : 's'}`
    super(
      `[${appName}] Invalid environment configuration — ${count}:\n` +
        issues.map((i) => `  • ${i}`).join('\n') +
        `\n\nExpected in ${envFile} (or the real process environment in CI/production).\n` +
        `Run: cp .env.example .env — then fill in every variable listed above.`,
    )
    this.name = 'EnvValidationError'
    this.issues = issues
  }
}

export interface ValidateEnvOptions<T extends z.ZodType> {
  schema: T
  /** Used to prefix the error so it is obvious which app refused to start. */
  appName: string
  /** Path shown to the reader, e.g. `.env` at the repo root. */
  envFile: string
  source?: Record<string, string | undefined>
}

/**
 * Parses `source` against `schema`, throwing a single error that lists every
 * offending variable at once rather than failing on the first one.
 */
export function validateEnv<T extends z.ZodType>(options: ValidateEnvOptions<T>): z.infer<T> {
  const { schema, appName, envFile } = options
  const source = options.source ?? (process.env as Record<string, string | undefined>)

  const result = schema.safeParse(source)
  if (result.success) return result.data

  const issues = result.error.issues.map((issue) => {
    const key = issue.path.join('.')
    if (!key) return issue.message
    // Zod reports a missing variable as a type error ("expected string, received
    // undefined"), which reads as a bug rather than an unset variable.
    return source[key] === undefined ? `${key}: missing (not set)` : `${key}: ${issue.message}`
  })

  throw new EnvValidationError(appName, envFile, issues)
}
