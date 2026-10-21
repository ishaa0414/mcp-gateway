'use client'
import Link from 'next/link'
import { SchemaField, fieldKindLabel } from '@/components/schema-field'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import type { PlaygroundField } from '@/lib/playground/fields'
import type { HiddenDraft } from '@/lib/tool-editor/hidden-params'

/**
 * The "Parameters" tab of the tool editor: for each input parameter, a switch to hide it from agents and,
 * when hidden, the fixed value the gateway sends in its place.
 */
export function ToolParameters({
  fields,
  draft,
  errors,
  projectSlug,
  onChange,
}: {
  fields: PlaygroundField[]
  draft: HiddenDraft
  errors: Record<string, string>
  projectSlug: string
  onChange: (name: string, next: { hidden: boolean; text: string }) => void
}) {
  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        A hidden parameter is removed from what agents see, and the gateway always sends the fixed value you set. Leave the value empty on an optional
        parameter to never send it.
      </p>
      <p className="text-xs text-muted-foreground">
        Hidden values are stored as plain text and visible to you here. Put secrets in the project credential (
        <Link href={`/projects/${projectSlug}/settings`} className="underline underline-offset-2">
          Settings
        </Link>
        ), which is encrypted.
      </p>

      {fields.length === 0 ? (
        <p className="py-4 text-center text-sm text-muted-foreground">This tool has no input parameters.</p>
      ) : (
        <ul className="divide-y rounded-lg border">
          {fields.map((field) => {
            const row = draft[field.name] ?? { hidden: false, text: '' }
            const id = `hidden-${field.name}`
            const error = errors[field.name]
            return (
              <li key={field.name} className="space-y-2 px-4 py-3">
                <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between sm:gap-3">
                  <div className="min-w-0">
                    <code className="text-sm font-medium">{field.name}</code>
                    {field.required && (
                      <span className="text-destructive" aria-hidden="true">
                        {' '}
                        *
                      </span>
                    )}
                    <span className="ml-2 text-xs text-muted-foreground">{fieldKindLabel(field)}</span>
                    {field.description && <p className="truncate text-xs text-muted-foreground">{field.description}</p>}
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <Label htmlFor={`${id}-switch`} className="text-xs font-normal text-muted-foreground">
                      Hide from agents
                    </Label>
                    <Switch
                      id={`${id}-switch`}
                      checked={row.hidden}
                      onCheckedChange={(hidden) => onChange(field.name, { ...row, hidden })}
                      aria-label={`Hide ${field.name} from agents`}
                    />
                  </div>
                </div>
                {row.hidden && (
                  <div className="space-y-1">
                    <Label htmlFor={id} className="text-xs">
                      Fixed value
                    </Label>
                    <SchemaField field={field} id={id} value={row.text} error={error} onChange={(text) => onChange(field.name, { ...row, text })} />
                    {!field.required && row.text.trim() === '' && !error && <p className="text-xs text-muted-foreground">Empty: this parameter is never sent.</p>}
                  </div>
                )}
                {error && (
                  <p id={`${id}-error`} role="alert" className="text-xs text-destructive">
                    {error}
                  </p>
                )}
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
