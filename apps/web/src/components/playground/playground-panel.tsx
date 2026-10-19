'use client'
import { useState, useTransition } from 'react'
import { Loader2, Play } from 'lucide-react'
import { runPlayground } from '@/actions/playground'
import { ResultPanel } from '@/components/playground/result-panel'
import { SchemaField, fieldKindLabel } from '@/components/schema-field'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Label } from '@/components/ui/label'
import { toArguments, type FieldValues } from '@/lib/playground/fields'
import { confirmMessage, requestNote } from '@/lib/playground/notes'
import type { PlaygroundResult } from '@/lib/playground/result'
import type { PlaygroundTool } from '@/lib/playground/tools'

const selectClass =
  'flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50'

export function PlaygroundPanel({ slug, tools, hasCredential }: { slug: string; tools: PlaygroundTool[]; hasCredential: boolean }) {
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
  const facts = { hasCredential, hasHidden: tool.hasHidden }

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
            Calls your real API through the gateway, the way an agent would. These calls are not logged and do not appear in Analytics.
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
                      <span className="ml-2 text-xs font-normal text-muted-foreground">{fieldKindLabel(field)}</span>
                    </Label>
                    <SchemaField
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
        {result && (
          <div className={isPending ? 'opacity-50' : undefined}>
            <ResultPanel result={result} note={requestNote(facts)} />
          </div>
        )}
      </div>

      <Dialog open={confirming} onOpenChange={setConfirming}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Send a real {tool.method} request?</DialogTitle>
            <DialogDescription>{confirmMessage(tool.method, tool.path, facts)}</DialogDescription>
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
