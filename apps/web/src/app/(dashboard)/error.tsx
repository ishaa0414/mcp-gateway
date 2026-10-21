'use client'
import { ErrorPanel, type RouteErrorProps } from '@/components/error-panel'

/** An error in a dashboard page. The sidebar stays, because an error page does not replace its own layout. */
export default function DashboardError({ error, retry }: RouteErrorProps) {
  return <ErrorPanel error={error} retry={retry} />
}
