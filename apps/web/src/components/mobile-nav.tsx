'use client'
import * as DialogPrimitive from '@radix-ui/react-dialog'
import { Menu, X } from 'lucide-react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { FOCUS_RING } from '@/lib/utils'

/**
 * The phone layout below `md` (768 px): a top bar with the brand and a menu button, and a drawer with the same
 * navigation and user block as the desktop sidebar (passed in as children, rendered on the server, so Sign out
 * stays a server action). The drawer is Radix Dialog: it traps focus, closes on Esc and on a tap outside, hides
 * the page behind it from assistive technology, and returns focus to the menu button when it closes.
 */
export function MobileNav({ children }: { children: React.ReactNode }) {
  const pathname = usePathname()
  // Keyed by the path, so going to another page starts with the drawer closed.
  return <Drawer key={pathname}>{children}</Drawer>
}

function Drawer({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = useState(false)

  return (
    <header className="flex h-14 shrink-0 items-center justify-between border-b bg-sidebar px-4 md:hidden">
      <Link href="/projects" className={`rounded-sm text-lg font-semibold tracking-tight ${FOCUS_RING}`}>
        MCP Gateway
      </Link>

      <DialogPrimitive.Root open={open} onOpenChange={setOpen}>
        <DialogPrimitive.Trigger asChild>
          <Button variant="ghost" size="icon" aria-label="Open menu" className={FOCUS_RING}>
            <Menu className="h-5 w-5" />
          </Button>
        </DialogPrimitive.Trigger>
        <DialogPrimitive.Portal>
          <DialogPrimitive.Overlay className="fixed inset-0 z-40 bg-black/50 md:hidden" />
          <DialogPrimitive.Content
            aria-describedby={undefined}
            className="fixed inset-y-0 left-0 z-50 flex h-dvh w-72 max-w-[85vw] flex-col border-r bg-sidebar shadow-lg focus:outline-none md:hidden"
            // A tap on a link (including the page you are already on) closes the drawer.
            onClick={(event) => {
              if ((event.target as HTMLElement).closest('a')) setOpen(false)
            }}
          >
            <div className="flex h-14 shrink-0 items-center justify-between border-b px-4">
              <DialogPrimitive.Title className="text-lg font-semibold tracking-tight">Menu</DialogPrimitive.Title>
              <DialogPrimitive.Close asChild>
                <Button variant="ghost" size="icon" aria-label="Close menu" className={FOCUS_RING}>
                  <X className="h-5 w-5" />
                </Button>
              </DialogPrimitive.Close>
            </div>
            {children}
          </DialogPrimitive.Content>
        </DialogPrimitive.Portal>
      </DialogPrimitive.Root>
    </header>
  )
}
