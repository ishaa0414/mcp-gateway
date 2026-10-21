import { NotFoundPanel } from '@/components/not-found-panel'

/** A URL that matches no page. */
export default function RootNotFound() {
  return (
    <div className="flex min-h-screen items-center justify-center">
      <NotFoundPanel title="Page not found" message="There is nothing at this address." />
    </div>
  )
}
