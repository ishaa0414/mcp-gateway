// All dashboard pages are authenticated and data-driven — never statically generated.
export const dynamic = 'force-dynamic'

import { auth } from '@/auth'
import { redirect } from 'next/navigation'
import { Sidebar } from '@/components/sidebar'

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const session = await auth()
  if (!session?.user) redirect('/sign-in')

  return (
    <div className="flex h-screen overflow-hidden bg-background">
      <Sidebar user={session.user} />
      <main className="flex-1 overflow-y-auto">{children}</main>
    </div>
  )
}
