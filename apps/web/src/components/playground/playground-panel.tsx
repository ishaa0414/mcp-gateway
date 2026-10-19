'use client'
import { useState, useTransition } from 'react'
import { Loader2, Play } from 'lucide-react'
import { runPlayground } from '@/actions/playground'
import { ResultPanel } from '@/components/playground/result-panel'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { toArguments, type FieldValues, type PlaygroundField } from '@/lib/playground/fields'
import type { PlaygroundResult } from '@/lib/playground/result'
import type { PlaygroundTool } from '@/lib/playground/tools'

const selectClass =
  'flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50'

function FieldControl({
  field,
  id,
  value,
  error,
  onChange,
}: {
  field: PlaygroundField
  id: string
  value: string
  error: string | undefined
  onChange: (value: string) => void
}) {
  const describedBy = error ? `${id}-error` : undefined
  const common = { id, 'aria-invalid': error ? true : undefined, 'aria-describedby': describedBy }

  switch (field.kind) {
    case 'boolean':
      return (
        <select {...common} className={selectClass} value={value} onChange={(e) => onChange(e.target.value)}>
          {!field.required && <option value="">(not set)</option>}
          {field.required && <option value="">Choose…</option>}
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

export function PlaygroundPanel({ slug, tools }: { slug: string; tools: PlaygroundTool[] }) {
  const [toolId, setToolId] = useState(tools[0]?.id ?? '')
  const [values, setValues] = useState<Record<string, FieldValues>>({})
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [result, setResult] = useState<PlaygroundResult | null>(null)
  const [confirming, setConfirming] = useState(false)
  const [isPending, startTransition] = useTransition()

  const tool = tools.find((t) => t.id === toolId) ?? tools[0]
  if (!tool) return null
  const current = values[tool.id] ?? {}
  const changesData = tool.method !== 'GET'

  function run(confirmed: boolean) {
    if (!tool) return
    const built = toArguments(tool.fields, current)
    if (!built.ok) {
      setErrors(built.errors)
      setConfirming(false)
      return
    }
    setErrors({})
    setConfirming(false)
    startTransition(async () => {
      try {
        setResult(await runPlayground({ slug, toolId: tool.id, arguments: built.arguments, ...(confirmed ? { confirmed: true } : {}) }))
      } catch {
        setResult({ status: 'unavailable' })
      }
    })
  }

  function submit(e: React.FormEvent) {
    e.preventDefault()
    const built = toArguments(tool!.fields, current)
    if (!built.ok) return setErrors(built.errors)
    setErrors({})
    if (changesData) setConfirming(true)
    else run(false)
  }

  return (
    <div className="max-w-3xl space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Run a tool</CardTitle>
          <CardDescription>
            Calls your real API through the gateway with your stored credential, the way an agent would. These calls are not logged and do not
            appear in Analytics.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={submit} className="space-y-5" noValidate>
            <div className="space-y-1.5">
              <Label htmlFor="playground-tool">Tool</Label>
              <select
                id="playground-tool"
                className={selectClass}
                value={tool.id}
                onChange={(e) => {
                  setToolId(e.target.value)
                  setErrors({})
                  setResult(null)
                }}
              >
                {tools.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.method} {t.path} — {t.name}
                  </option>
                ))}
              </select>
              <div className="flex flex-wrap items-center gap-2 pt-1">
                <Badge variant={changesData ? 'warning' : 'secondary'}>{tool.method}</Badge>
                <code className="text-xs">{tool.path}</code>
              </div>
              {tool.description && <p className="text-sm text-muted-foreground">{tool.description}</p>}
            </div>

            {tool.fields.length === 0 ? (
              <p className="text-sm text-muted-foreground">This tool takes no arguments.</p>
            ) : (
              tool.fields.map((field) => {
                const id = `field-${tool.id}-${field.name}`
                return (
                  <div key={field.name} className="space-y-1.5">
                    <Label htmlFor={id}>
                      {field.name}
                      {field.required && (
                        <span className="text-destructive" aria-hidden="true">
                          {' '}
                          *
                        </span>
                      )}
                      <span className="ml-2 text-xs font-normal text-muted-foreground">
                        {field.kind === 'enum' ? 'one of' : field.kind}
                        {field.required ? ', required' : ''}
                      </span>
                    </Label>
                    <FieldControl
                      field={field}
                      id={id}
                      value={current[field.name] ?? ''}
                      error={errors[field.name]}
                      onChange={(value) => setValues((v) => ({ ...v, [tool.id]: { ...v[tool.id], [field.name]: value } }))}
                    />
                    {field.description && <p className="text-xs text-muted-foreground">{field.description}</p>}
                    {errors[field.name] && (
                      <p id={`${id}-error`} role="alert" className="text-xs text-destructive">
                        {errors[field.name]}
                      </p>
                    )}
                  </div>
                )
              })
            )}

            <Button type="submit" disabled={isPending}>
              {isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" /> : <Play className="mr-2 h-4 w-4" aria-hidden="true" />}
              {isPending ? 'Running…' : 'Run'}
            </Button>
          </form>
        </CardContent>
      </Card>

      <div aria-live="polite" aria-busy={isPending}>
        {isPending && !result && <p className="text-sm text-muted-foreground">Waiting for the gateway…</p>}
        {result && <div className={isPending ? 'opacity-50' : undefined}><ResultPanel result={result} /></div>}
      </div>

      <Dialog open={confirming} onOpenChange={setConfirming}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Send a real {tool.method} request?</DialogTitle>
            <DialogDescription>
              This will send a real {tool.method} to <code className="text-xs">{tool.path}</code> with your stored credential. It can change or delete data in
              your API.
            </DialogDescription>
          </DialogHeader>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setConfirming(false)}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={() => run(true)}>
              Send {tool.method}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}
