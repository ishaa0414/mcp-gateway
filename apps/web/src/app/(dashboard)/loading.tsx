import { LoadingState } from '@/components/loading-state'
import { Skeleton } from '@/components/ui/skeleton'

/** While a dashboard page loads: a title and a few cards. */
export default function DashboardLoading() {
  return (
    <LoadingState label="Loading" className="space-y-6 p-8">
      <div className="space-y-2">
        <Skeleton className="h-7 w-48" />
        <Skeleton className="h-4 w-72" />
      </div>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {Array.from({ length: 3 }, (_, i) => (
          <Skeleton key={i} className="h-28 rounded-xl" />
        ))}
      </div>
    </LoadingState>
  )
}
