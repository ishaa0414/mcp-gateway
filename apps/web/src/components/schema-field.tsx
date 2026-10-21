'use client'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import type { PlaygroundField } from '@/lib/playground/fields'

const selectClass =
  'flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50'

/** The kind and requirement of a field, in words, for its label. */
export function fieldKindLabel(field: PlaygroundField): string {
  const kind = field.kind === 'enum' ? 'one of' : field.kind === 'list' ? `list of ${field.itemKind ?? 'string'}` : field.kind
  return `${kind}${field.required ? ', required' : ''}`
}

/**
 * The control for one schema field: a text box, a select for booleans and enums, one value per line for a
 * list of plain values, and JSON text for everything else. The value is always a string, in the form
 * `toArguments` reads back (an enum holds the index of the chosen option).
 */
export function SchemaField({
  field,
  id,
  value,
  error,
  disabled,
  onChange,
}: {
  field: PlaygroundField
  id: string
  value: string
  error?: string | undefined
  disabled?: boolean
  onChange: (value: string) => void
}) {
  const common = { id, disabled, 'aria-invalid': error ? true : undefined, 'aria-describedby': error ? `${id}-error` : undefined }

  switch (field.kind) {
    case 'boolean':
      return (
        <select {...common} className={selectClass} value={value} onChange={(e) => onChange(e.target.value)}>
          <option value="">{field.required ? 'Choose…' : '(not set)'}</option>
          <option value="true">true</option>
          <option value="false">false</option>
        </select>
      )
    case 'enum':
      return (
        <select {...common} className={selectClass} value={value} onChange={(e) => onChange(e.target.value)}>
          <option value="">{field.required ? 'Choose…' : '(not set)'}</option>
          {field.options?.map((option, index) => (
            <option key={index} value={String(index)}>
              {String(option)}
            </option>
          ))}
        </select>
      )
    case 'list':
      return (
        <Textarea
          {...common}
          className="font-mono text-xs"
          rows={3}
          spellCheck={false}
          placeholder="One value per line"
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
      )
    case 'json':
      return (
        <Textarea
          {...common}
          className="font-mono text-xs"
          rows={4}
          spellCheck={false}
          placeholder='JSON, for example {"name": "Rex"} or ["a", "b"]'
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
      )
    case 'number':
    case 'integer':
      return <Input {...common} type="text" inputMode="decimal" autoComplete="off" value={value} onChange={(e) => onChange(e.target.value)} />
    default:
      return <Input {...common} type="text" autoComplete="off" value={value} onChange={(e) => onChange(e.target.value)} />
  }
}
