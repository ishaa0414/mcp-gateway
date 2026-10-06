import { afterAll, describe, expect, it } from 'vitest'
import { db } from '@mcp-gateway/db'
import { signUp } from '@/actions/auth'
import { authenticateCredentials } from '@/lib/credentials'
import { emailSchema, normalizeEmail } from '@/lib/email'

const stamp = Date.now()
const local = `Ada.${stamp}`
const password = 'correct-horse-battery'

afterAll(async () => {
  await db.user.deleteMany({ where: { email: { endsWith: `${stamp}@example.com` } } })
})

describe('normalizeEmail / emailSchema', () => {
  it('trims and lowercases', () => {
    expect(normalizeEmail('  Ada@Example.COM \t')).toBe('ada@example.com')
  })

  it('validates after normalising, so padded input is accepted', () => {
    expect(emailSchema.parse('  Ada@Example.COM ')).toBe('ada@example.com')
  })

  it('rejects things that are not emails', () => {
    for (const bad of ['', '   ', 'not-an-email', 'a@', '@b.com']) {
      expect(emailSchema.safeParse(bad).success).toBe(false)
    }
  })
})

describe('sign-up and sign-in use the same normalisation', () => {
  it('stores the normalised email on sign-up', async () => {
    const res = await signUp({ name: ' Ada ', email: `  ${local}@Example.COM `, password })
    expect(res).toEqual({})

    const user = await db.user.findUniqueOrThrow({ where: { email: `${local.toLowerCase()}@example.com` } })
    expect(user.name).toBe('Ada')
  })

  it('signs in however the email is cased or padded', async () => {
    const variants = [
      `${local}@example.com`,
      `${local.toLowerCase()}@example.com`,
      `  ${local.toUpperCase()}@EXAMPLE.COM  `,
    ]
    for (const email of variants) {
      const user = await authenticateCredentials(db, { email, password })
      expect(user?.email).toBe(`${local.toLowerCase()}@example.com`)
    }
  })

  it('treats a differently-cased duplicate as the same account', async () => {
    const res = await signUp({ name: 'Ada again', email: `${local.toUpperCase()}@example.com`, password })
    expect(res.error).toMatch(/already exists/)
  })

  it('rejects a wrong password, an unknown user and a malformed login the same way', async () => {
    const email = `${local}@example.com`
    expect(await authenticateCredentials(db, { email, password: 'wrong-password' })).toBeNull()
    expect(await authenticateCredentials(db, { email: `nobody-${stamp}@example.com`, password })).toBeNull()
    expect(await authenticateCredentials(db, { email: 'not-an-email', password })).toBeNull()
    expect(await authenticateCredentials(db, undefined)).toBeNull()
  })

  it('validates sign-up input on the server too', async () => {
    expect((await signUp({ name: 'x', email: 'nope', password })).error).toBeTruthy()
    expect((await signUp({ name: 'x', email: `short-${stamp}@example.com`, password: 'short' })).error).toMatch(
      /at least 8/
    )
    expect((await signUp({ name: '  ', email: `blank-${stamp}@example.com`, password })).error).toMatch(/Name/)
  })
})
