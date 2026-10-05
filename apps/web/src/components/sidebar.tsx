import Link from 'next/link'
import { signOut } from '@/auth'
import { Button } from '@/components/ui/button'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { LayoutDashboard, LogOut } from 'lucide-react'
import type { Session } from 'next-auth'

interface SidebarProps {
  user: NonNullable<Session['user']>
}

export function Sidebar({ user }: SidebarProps) {
  const initials = (user.name ?? user.email ?? '?')
    .split(' ')
    .map((s: string) => s[0])
    .slice(0, 2)
    .join('')
    .toUpperCase()

  return (
    <aside className="flex h-screen w-64 flex-col border-r bg-sidebar">
      <div className="flex h-14 items-center border-b px-4">
        <Link href="/projects" className="text-lg font-semibold tracking-tight">
          MCP Gateway
        </Link>
      </div>

      <nav className="flex-1 space-y-1 p-2">
        <Link
          href="/projects"
          className="flex items-center gap-2 rounded-md px-3 py-2 text-sm font-medium hover:bg-accent hover:text-accent-foreground"
        >
          <LayoutDashboard className="h-4 w-4" />
          Projects
        </Link>
      </nav>

      <div className="border-t p-3">
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
            <Button variant="ghost" size="icon" type="submit" title="Sign out">
              <LogOut className="h-4 w-4" />
            </Button>
          </form>
        </div>
      </div>
    </aside>
  )
}
