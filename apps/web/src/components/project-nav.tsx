'use client'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useEffect, useRef } from 'react'
import { cn, FOCUS_RING } from '@/lib/utils'

const tabs = [
  { label: 'Overview', href: (slug: string) => `/projects/${slug}/overview` },
  { label: 'Spec', href: (slug: string) => `/projects/${slug}/spec` },
  { label: 'Tools', href: (slug: string) => `/projects/${slug}/tools` },
  { label: 'Playground', href: (slug: string) => `/projects/${slug}/playground` },
  { label: 'API Keys', href: (slug: string) => `/projects/${slug}/api-keys` },
  { label: 'Connect', href: (slug: string) => `/projects/${slug}/connect` },
  { label: 'Analytics', href: (slug: string) => `/projects/${slug}/analytics` },
  { label: 'Settings', href: (slug: string) => `/projects/${slug}/settings` },
]

export function ProjectNav({ slug }: { slug: string }) {
  const pathname = usePathname()
  const scroller = useRef<HTMLDivElement>(null)

  // On a narrow screen the tabs scroll sideways; keep the current one in view.
  useEffect(() => {
    scroller.current?.querySelector('[aria-current="page"]')?.scrollIntoView({ block: 'nearest', inline: 'center' })
  }, [pathname])

  return (
    // The scroller clips overflow, so the pb-px leaves room for the active tab's underline, which overlaps the border by 1px.
    <div ref={scroller} className="-mx-4 overflow-x-auto px-4 pb-px md:mx-0 md:px-0">
      <nav className="flex w-max min-w-full gap-1 border-b" aria-label="Project tabs">
        {tabs.map((tab) => {
          const href = tab.href(slug)
          const active = pathname.startsWith(href)
          return (
            <Link
              key={tab.label}
              href={href}
              aria-current={active ? 'page' : undefined}
              className={cn(
                '-mb-px shrink-0 whitespace-nowrap border-b-2 px-4 py-2 text-sm font-medium transition-colors',
                FOCUS_RING,
                active ? 'border-foreground text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground'
              )}
            >
              {tab.label}
            </Link>
          )
        })}
      </nav>
    </div>
  )
}
