import { LoadingState } from '@/components/loading-state'
import { Skeleton } from '@/components/ui/skeleton'

/** While a project tab loads (under the project header and tabs). Tabs with their own shape have their own file. */
export default function ProjectTabLoading() {
  return (
    <LoadingState label="Loading" className="max-w-2xl space-y-4">
      <Skeleton className="h-6 w-40" />
      <Skeleton className="h-40 rounded-xl" />
      <Skeleton className="h-28 rounded-xl" />
    </LoadingState>
  )
}
