'use client'
import { ErrorPanel, type RouteErrorProps } from '@/components/error-panel'
import './globals.css'

/**
 * An error in the root layout itself. It replaces the layout, so it brings its own document and styles. Nothing
 * on the page can reach it in normal use; the render test is what covers it.
 */
export default function GlobalError({ error, retry }: RouteErrorProps) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-background text-foreground antialiased">
        <div className="flex min-h-screen items-center justify-center">
          <ErrorPanel error={error} retry={retry} />
        </div>
      </body>
    </html>
  )
}
