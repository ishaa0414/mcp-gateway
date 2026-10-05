'use server'
import { hash } from '@node-rs/argon2'
import { db } from '@/lib/db'

interface SignUpInput {
  name: string
  email: string
  password: string
}

export async function signUp(input: SignUpInput): Promise<{ error?: string }> {
  const { name, email, password } = input

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
