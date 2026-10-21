import { LoadingState } from '@/components/loading-state'
import { Skeleton } from '@/components/ui/skeleton'

/** The Tools tab: a heading and a list of rows (switch, name and method, description, edit button). */
export default function ToolsLoading() {
  return (
    <LoadingState label="Loading tools" className="space-y-4">
      <div className="space-y-2">
        <Skeleton className="h-6 w-24" />
        <Skeleton className="h-4 w-80" />
      </div>
      <div className="divide-y rounded-lg border">
        {Array.from({ length: 6 }, (_, i) => (
          <div key={i} className="flex items-center gap-3 px-4 py-3">
            <Skeleton className="h-5 w-9 rounded-full" />
            <div className="flex-1 space-y-2">
              <Skeleton className="h-4 w-48" />
              <Skeleton className="h-3 w-3/4" />
            </div>
            <Skeleton className="h-8 w-8" />
          </div>
        ))}
      </div>
    </LoadingState>
  )
}
