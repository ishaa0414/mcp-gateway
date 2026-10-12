'use client'
import { useEffect, useRef, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { setViewerTimeZone } from '@/actions/analytics'

/**
 * First visit: tell the server the browser's zone (it lands in a cookie), then re-render the page
 * with it. Runs once per mount, so a failure leaves the skeleton instead of looping.
 */
export function TimeZoneSync() {
  const router = useRouter()
  const [, startTransition] = useTransition()
  const started = useRef(false)

  useEffect(() => {
    if (started.current) return
    started.current = true
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
    startTransition(async () => {
      const res = await setViewerTimeZone(zone)
      if (res.ok) router.refresh()
    })
  }, [router])

  return null
}
