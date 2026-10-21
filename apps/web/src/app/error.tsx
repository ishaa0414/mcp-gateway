'use client'
import { ErrorPanel, type RouteErrorProps } from '@/components/error-panel'

/** Any error under the root layout that no nearer error page caught (the sign-in pages, for one). */
export default function RootError({ error, retry }: RouteErrorProps) {
  return (
    <div className="flex min-h-screen items-center justify-center">
      <ErrorPanel error={error} retry={retry} />
    </div>
  )
}
