import type { NextAuthConfig } from 'next-auth'
import GitHub from 'next-auth/providers/github'
import Credentials from 'next-auth/providers/credentials'

/**
 * Edge-safe auth config.
 * - No Prisma imports (not available in Edge runtime)
 * - Credentials.authorize is intentionally absent here; it lives in auth.ts
 * - Used by middleware.ts for route protection
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
