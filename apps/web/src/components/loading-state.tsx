/**
 * Wraps a skeleton so assistive technology hears what is loading, and the page says it is busy. The skeleton
 * blocks themselves are hidden from it.
 */
export function LoadingState({ label, className, children }: { label: string; className?: string; children: React.ReactNode }) {
  return (
    <div role="status" aria-busy="true" className={className}>
      <span className="sr-only">{label}</span>
      {children}
    </div>
  )
}
