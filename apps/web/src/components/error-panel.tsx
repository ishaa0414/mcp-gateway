'use client'

/** The props Next.js gives an error boundary file (`retry` re-fetches and re-renders the segment). */
export interface RouteErrorProps {
  error: Error & { digest?: string }
  retry: () => void
}

/**
 * What every error page shows. It never shows the error itself: `error.message` can hold database or
 * configuration details (Next.js hides it from server errors in production, but not in development, and not
 * for errors thrown in the browser), so the only thing taken from `error` is its digest, a hash a person can
 * quote and an operator can look up in the server log, where the real error is.
 */
export function ErrorPanel({ error, retry }: RouteErrorProps) {
  const digest = typeof error.digest === 'string' && error.digest !== '' ? error.digest : null

  return (
    <div role="alert" className="mx-auto max-w-lg space-y-4 p-8">
      <h2 className="text-lg font-semibold">Something went wrong.</h2>
      <p className="text-sm text-muted-foreground">
        {digest ? (
          <>
            Try again — if it keeps happening, share this reference: <code className="rounded bg-muted px-1.5 py-0.5 text-xs">{digest}</code>.
          </>
        ) : (
          'Try again.'
        )}
      </p>
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={() => retry()}
          className="inline-flex h-9 items-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground shadow hover:bg-primary/90"
        >
          Try again
        </button>
        {/* A plain link: after an error the client router may not be in a state to trust. */}
        <a href="/projects" className="text-sm underline underline-offset-2">
          Back to projects
        </a>
      </div>
    </div>
  )
}
