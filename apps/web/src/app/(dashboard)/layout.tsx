// All dashboard pages are authenticated and data-driven — never statically generated.
export const dynamic = 'force-dynamic'

import { auth } from '@/auth'
import { redirect } from 'next/navigation'
import { MobileNav } from '@/components/mobile-nav'
import { Sidebar, SidebarContent } from '@/components/sidebar'

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const session = await auth()
  if (!session?.user) redirect('/sign-in')

  return (
    // Below md: a top bar over the page. From md: the sidebar beside it. h-dvh follows a phone's moving address bar.
    <div className="flex h-dvh flex-col overflow-hidden bg-background md:flex-row">
      <MobileNav>
        <SidebarContent user={session.user} />
      </MobileNav>
      <Sidebar user={session.user} />
      <main className="min-h-0 min-w-0 flex-1 overflow-y-auto">{children}</main>
    </div>
  )
}
