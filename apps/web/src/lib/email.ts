import { z } from 'zod'

/** The one canonical form of an email: used on sign-up, sign-in and OAuth lookups. */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase()
}

/** Normalises before validating, so "  Ada@Example.COM " is accepted and stored as ada@example.com. */
export const emailSchema = z
  .string()
  .transform(normalizeEmail)
  .pipe(z.email('Invalid email'))
