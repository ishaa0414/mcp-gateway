import type { NextAuthConfig } from 'next-auth'
import GitHub from 'next-auth/providers/github'
import Credentials from 'next-auth/providers/credentials'

/**
 * Auth config shared with the proxy (src/proxy.ts), kept free of database code.
 * - No Prisma/argon2 imports: the proxy runs in front of the app and should not
 *   depend on the database layer
 * - Credentials.authorize is intentionally absent here; it lives in auth.ts
 * - Used by proxy.ts for route protection
 */
export const authConfig = {
  providers: [
    GitHub,
    Credentials({
      credentials: {
        email: { label: 'Email', type: 'email' },
        password: { label: 'Password', type: 'password' },
      },
    }),
  ],
  pages: {
    signIn: '/sign-in',
    error: '/sign-in',
  },
  callbacks: {
    authorized({ auth, request: { nextUrl } }) {
      const isLoggedIn = !!auth?.user
      const isDashboard =
        nextUrl.pathname.startsWith('/projects') ||
        nextUrl.pathname.startsWith('/dashboard')

      if (isDashboard) return isLoggedIn

      // Redirect logged-in users away from auth pages
      const isAuthPage =
        nextUrl.pathname.startsWith('/sign-in') ||
        nextUrl.pathname.startsWith('/sign-up')
      if (isLoggedIn && isAuthPage) {
        return Response.redirect(new URL('/projects', nextUrl))
      }

      return true
    },
  },
} satisfies NextAuthConfig
