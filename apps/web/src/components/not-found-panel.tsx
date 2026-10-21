import Link from 'next/link'

/**
 * Shown for a page or project that does not exist. The same words are used when the project exists but belongs to
 * someone else, so the page never says which of the two it was.
 */
export function NotFoundPanel({ title, message }: { title: string; message: string }) {
  return (
    <div className="mx-auto max-w-lg space-y-4 p-4 md:p-8">
      <h2 className="text-lg font-semibold">{title}</h2>
      <p className="text-sm text-muted-foreground">{message}</p>
      <Link href="/projects" className="inline-block text-sm underline underline-offset-2">
        Back to projects
      </Link>
    </div>
  )
}
