import { LoadingState } from '@/components/loading-state'
import { Skeleton } from '@/components/ui/skeleton'

/** The Spec tab: the two import cards (file and URL). The page itself fetches nothing, so this shows while it loads. */
export default function SpecLoading() {
  return (
    <LoadingState label="Loading" className="max-w-2xl space-y-4">
      <div className="space-y-2">
        <Skeleton className="h-6 w-36" />
        <Skeleton className="h-4 w-72" />
      </div>
      <Skeleton className="h-44 rounded-xl" />
      <Skeleton className="h-36 rounded-xl" />
    </LoadingState>
  )
}
