import NextAuth, { type DefaultSession } from 'next-auth'
import { PrismaAdapter } from '@auth/prisma-adapter'
import Credentials from 'next-auth/providers/credentials'
import { verify } from '@node-rs/argon2'
import { z } from 'zod'
import { db } from '@/lib/db'
import { authConfig } from './auth.config'

// Augment the Session type so session.user.id is typed
declare module 'next-auth' {
  interface Session {
    user: { id: string } & DefaultSession['user']
  }
}

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
})

export const { handlers, auth, signIn, signOut } = NextAuth({
  ...authConfig,
  adapter: PrismaAdapter(db),
  session: { strategy: 'jwt' },

  providers: [
    // Replace edge-safe Credentials stub with the full version
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ...authConfig.providers.filter((p) => (p as any).id !== 'credentials'),

    Credentials({
      credentials: {
        email: { label: 'Email', type: 'email' },
        password: { label: 'Password', type: 'password' },
      },
      async authorize(credentials) {
        const parsed = loginSchema.safeParse(credentials)
        if (!parsed.success) return null

        const { email, password } = parsed.data
        const user = await db.user.findUnique({ where: { email } })
        if (!user?.password) return null // No password → GitHub-only account

        const valid = await verify(user.password, password)
        if (!valid) return null

        return { id: user.id, email: user.email, name: user.name, image: user.image }
      },
    }),
  ],

  callbacks: {
    ...authConfig.callbacks,

    async signIn({ user, account }) {
      // Block GitHub OAuth if this email is registered as a password account
      if (account?.provider === 'github' && user.email) {
        const existing = await db.user.findUnique({ where: { email: user.email } })
        if (existing?.password) {
          // Signal an error — next-auth will redirect to /sign-in?error=OAuthAccountNotLinked
          return '/sign-in?error=account-exists'
        }
      }
      return true
    },

    async jwt({ token, user }) {
      if (user?.id) token.id = user.id
      return token
    },

    async session({ session, token }) {
      if (typeof token.id === 'string') session.user.id = token.id
      return session
    },
  },
})
