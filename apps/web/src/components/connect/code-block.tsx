import { CopyButton } from '@/components/copy-button'

/** A snippet with its label and a copy button. The text is shown as text, never as markup. */
export function CodeBlock({ label, text }: { label: string; text: string }) {
  return (
    <div className="space-y-1.5">
      <p className="text-xs font-medium text-muted-foreground">{label}</p>
      <div className="flex items-start justify-between gap-2 rounded-md bg-muted px-3 py-2">
        <pre aria-label={label} className="min-w-0 flex-1 overflow-x-auto whitespace-pre-wrap break-all font-mono text-xs">
          {text}
        </pre>
        <CopyButton value={text} className="shrink-0" />
      </div>
    </div>
  )
}
