import { verify } from '@node-rs/argon2'
import { z } from 'zod'
import type { PrismaClient } from '@mcp-gateway/db'
import { emailSchema } from '@/lib/email'

const loginSchema = z.object({
  email: emailSchema,
  password: z.string().min(8),
})

/**
 * Check an email + password pair. Returns the user, or null for any failure
 * (unknown email, GitHub-only account, wrong password) so callers cannot tell
 * which. The email is normalised exactly as on sign-up.
 */
export async function authenticateCredentials(db: PrismaClient, credentials: unknown) {
  const parsed = loginSchema.safeParse(credentials)
  if (!parsed.success) return null

  const { email, password } = parsed.data
  const user = await db.user.findUnique({ where: { email } })
  if (!user?.password) return null

  const valid = await verify(user.password, password)
  if (!valid) return null

  return { id: user.id, email: user.email, name: user.name, image: user.image }
}
