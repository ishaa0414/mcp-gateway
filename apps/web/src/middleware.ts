import NextAuth from 'next-auth'
import { authConfig } from './auth.config'

const { auth } = NextAuth(authConfig)

export default auth

export const config = {
  matcher: [
    /*
     * Protect all routes except:
     * - static files (_next/static, _next/image, favicon)
     * - public API routes (none yet)
     * - auth pages handled by authConfig.callbacks.authorized
     */
    '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
  ],
}
