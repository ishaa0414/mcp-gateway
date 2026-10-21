import * as React from 'react'
import { cn } from '@/lib/utils'

/** A grey block that stands in for content that is still loading. Decorative: the wrapper says what is loading. */
function Skeleton({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div aria-hidden="true" className={cn('animate-pulse rounded-md bg-muted', className)} {...props} />
}

export { Skeleton }
