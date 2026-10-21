import Link from 'next/link'
import { signOut } from '@/auth'
import { Button } from '@/components/ui/button'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { FOCUS_RING } from '@/lib/utils'
import { LayoutDashboard, LogOut } from 'lucide-react'
import type { Session } from 'next-auth'

interface SidebarProps {
  user: NonNullable<Session['user']>
}

/**
 * The navigation and the signed-in user, shared by the desktop sidebar and the phone drawer. The user block is
 * pinned to the bottom (`mt-auto`) and the links scroll above it, so Sign out is always reachable.
 */
export function SidebarContent({ user }: SidebarProps) {
  const initials = (user.name ?? user.email ?? '?')
    .split(' ')
    .map((s: string) => s[0])
    .slice(0, 2)
    .join('')
    .toUpperCase()

  return (
    <>
      <nav aria-label="Main" className="min-h-0 flex-1 space-y-1 overflow-y-auto p-2">
        <Link
          href="/projects"
          className={`flex items-center gap-2 rounded-md px-3 py-2 text-sm font-medium hover:bg-accent hover:text-accent-foreground ${FOCUS_RING}`}
        >
          <LayoutDashboard className="h-4 w-4" />
          Projects
        </Link>
      </nav>

      <div className="mt-auto shrink-0 border-t p-3">
        <div className="flex items-center gap-3">
          <Avatar className="h-8 w-8">
            {user.image && <AvatarImage src={user.image} alt={user.name ?? ''} />}
            <AvatarFallback className="text-xs">{initials}</AvatarFallback>
          </Avatar>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium">{user.name ?? 'User'}</p>
            <p className="truncate text-xs text-muted-foreground">{user.email}</p>
          </div>
          <form
            action={async () => {
              'use server'
              await signOut({ redirectTo: '/sign-in' })
            }}
          >
            <Button variant="ghost" size="icon" type="submit" title="Sign out" aria-label="Sign out" className={FOCUS_RING}>
              <LogOut className="h-4 w-4" />
            </Button>
          </form>
        </div>
      </div>
    </>
  )
}

/** The sidebar from `md` (768 px) up. Below that the top bar and its drawer take over (see MobileNav). */
export function Sidebar({ user }: SidebarProps) {
  return (
    <aside className="hidden h-full w-64 shrink-0 flex-col border-r bg-sidebar md:flex">
      <div className="flex h-14 shrink-0 items-center border-b px-4">
        <Link href="/projects" className={`rounded-sm text-lg font-semibold tracking-tight ${FOCUS_RING}`}>
          MCP Gateway
        </Link>
      </div>
      <SidebarContent user={user} />
    </aside>
  )
}
