import { LoadingState } from '@/components/loading-state'
import { Skeleton } from '@/components/ui/skeleton'

/** The API Keys tab: a heading with a button, and rows for the keys. */
export default function ApiKeysLoading() {
  return (
    <LoadingState label="Loading API keys" className="max-w-3xl space-y-4">
      <div className="flex items-center justify-between">
        <div className="space-y-2">
          <Skeleton className="h-6 w-28" />
          <Skeleton className="h-4 w-64" />
        </div>
        <Skeleton className="h-9 w-28" />
      </div>
      <div className="divide-y rounded-lg border">
        {Array.from({ length: 3 }, (_, i) => (
          <div key={i} className="flex items-center justify-between gap-4 px-4 py-3">
            <div className="space-y-2">
              <Skeleton className="h-4 w-36" />
              <Skeleton className="h-3 w-52" />
            </div>
            <Skeleton className="h-8 w-20" />
          </div>
        ))}
      </div>
    </LoadingState>
  )
}
