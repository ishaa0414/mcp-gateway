'use server'
import { hash } from '@node-rs/argon2'
import { z } from 'zod'
import { db } from '@/lib/db'
import { emailSchema } from '@/lib/email'

const SignUpSchema = z.object({
  name: z.string().trim().min(1, 'Name is required').max(100),
  email: emailSchema,
  password: z.string().min(8, 'Password must be at least 8 characters'),
})

export async function signUp(input: {
  name: string
  email: string
  password: string
}): Promise<{ error?: string }> {
  const parsed = SignUpSchema.safeParse(input)
  if (!parsed.success) {
    return { error: parsed.error.issues.map((i) => i.message).join(', ') }
  }
  const { name, email, password } = parsed.data

  const existing = await db.user.findUnique({ where: { email } })
  if (existing) {
    return { error: 'An account with this email already exists.' }
  }

  const passwordHash = await hash(password)

  await db.user.create({
    data: { name, email, password: passwordHash },
  })

  return {}
}
