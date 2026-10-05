'use client'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { cn } from '@/lib/utils'

const tabs = [
  { label: 'Overview', href: (slug: string) => `/projects/${slug}/overview` },
  { label: 'Spec', href: (slug: string) => `/projects/${slug}/spec` },
  { label: 'Tools', href: (slug: string) => `/projects/${slug}/tools` },
  { label: 'Settings', href: (slug: string) => `/projects/${slug}/settings` },
]

export function ProjectNav({ slug }: { slug: string }) {
  const pathname = usePathname()

  return (
    <nav className="flex gap-1 border-b -mb-px" aria-label="Project tabs">
      {tabs.map((tab) => {
        const href = tab.href(slug)
        const active = pathname.startsWith(href)
        return (
          <Link
            key={tab.label}
            href={href}
            className={cn(
              'border-b-2 px-4 py-2 text-sm font-medium transition-colors',
              active
                ? 'border-foreground text-foreground'
                : 'border-transparent text-muted-foreground hover:text-foreground'
            )}
          >
            {tab.label}
          </Link>
        )
      })}
    </nav>
  )
}
