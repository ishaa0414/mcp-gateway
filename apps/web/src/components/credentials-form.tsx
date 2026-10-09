'use client'
import { useState, useTransition } from 'react'
import { updateCredential, type CredentialSummary } from '@/actions/credentials'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

type Kind = CredentialSummary['type']

const OPTIONS: Array<{ kind: Kind; label: string }> = [
  { kind: 'NONE', label: 'None' },
  { kind: 'BEARER', label: 'Bearer token' },
  { kind: 'CUSTOM_HEADER', label: 'Custom header' },
  { kind: 'QUERY_PARAM', label: 'Query parameter' },
]

export function CredentialsForm({ slug, summary }: { slug: string; summary: CredentialSummary }) {
  const [saved, setSaved] = useState(summary)
  const [kind, setKind] = useState<Kind>(summary.type)
  const [headerName, setHeaderName] = useState(summary.headerName ?? '')
  const [queryParamName, setQueryParamName] = useState(summary.queryParamName ?? '')
  const [value, setValue] = useState('')
  const [replacing, setReplacing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [isPending, startTransition] = useTransition()

  // The stored secret is never in the browser. If the kind is unchanged we show a mask and the
  // user can keep it (leave the value empty) or replace it; a different kind always needs a new value.
  const hasStoredSecret = saved.hasValue && saved.type === kind
  const showMask = hasStoredSecret && !replacing

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    setMessage(null)

    const input =
      kind === 'NONE'
        ? { type: 'NONE' }
        : kind === 'BEARER'
          ? { type: kind, value }
          : kind === 'CUSTOM_HEADER'
            ? { type: kind, headerName, value }
            : { type: kind, queryParamName, value }

    startTransition(async () => {
      const res = await updateCredential(slug, input)
      if (res.error || !res.summary) {
        setError(res.error ?? 'Could not save the credential')
        return
      }
      setSaved(res.summary)
      setKind(res.summary.type)
      setValue('')
      setReplacing(false)
      setMessage(res.summary.type === 'NONE' ? 'Upstream authentication removed.' : 'Credential saved.')
    })
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Upstream authentication</CardTitle>
        <CardDescription>
          How the gateway authenticates to your API when a tool is called. The secret is stored encrypted and is never shown again after
          saving.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {error && (
          <p role="alert" className="mb-4 rounded bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {error}
          </p>
        )}
        {message && (
          <p role="status" className="mb-4 rounded bg-green-500/10 px-3 py-2 text-sm text-green-700 dark:text-green-400">
            {message}
          </p>
        )}
        <form onSubmit={handleSubmit} className="space-y-4">
          <fieldset className="grid grid-cols-2 gap-2">
            <legend className="sr-only">Authentication type</legend>
            {OPTIONS.map((o) => (
              <label
                key={o.kind}
                className={`flex cursor-pointer items-center gap-2 rounded-md border px-3 py-2 text-sm ${
                  kind === o.kind ? 'border-foreground bg-accent' : 'hover:bg-accent/50'
                }`}
              >
                <input
                  type="radio"
                  name="credentialKind"
                  value={o.kind}
                  checked={kind === o.kind}
                  onChange={() => {
                    setKind(o.kind)
                    setReplacing(false)
                    setValue('')
                  }}
                />
                {o.label}
              </label>
            ))}
          </fieldset>

          {kind === 'CUSTOM_HEADER' && (
            <div className="space-y-1.5">
              <Label htmlFor="headerName">Header name</Label>
              <Input id="headerName" value={headerName} onChange={(e) => setHeaderName(e.target.value)} placeholder="X-Api-Key" autoComplete="off" />
            </div>
          )}
          {kind === 'QUERY_PARAM' && (
            <div className="space-y-1.5">
              <Label htmlFor="queryParamName">Query parameter name</Label>
              <Input id="queryParamName" value={queryParamName} onChange={(e) => setQueryParamName(e.target.value)} placeholder="api_key" autoComplete="off" />
            </div>
          )}

          {kind !== 'NONE' && (
            <div className="space-y-1.5">
              <Label htmlFor="credentialValue">{kind === 'BEARER' ? 'Token' : 'Value'}</Label>
              {showMask ? (
                <div className="flex items-center gap-2">
                  <Input id="credentialValue" value="••••••••" readOnly aria-label="Stored secret (hidden)" className="font-mono" />
                  <Button type="button" variant="outline" size="sm" onClick={() => setReplacing(true)}>
                    Replace
                  </Button>
                </div>
              ) : (
                <Input
                  id="credentialValue"
                  type="password"
                  value={value}
                  onChange={(e) => setValue(e.target.value)}
                  autoComplete="new-password"
                  placeholder={hasStoredSecret ? 'Leave empty to keep the current secret' : undefined}
                />
              )}
              <p className="text-xs text-muted-foreground">
                {kind === 'BEARER' && 'Sent as the header Authorization: Bearer <token>.'}
                {kind === 'CUSTOM_HEADER' && 'Sent as the value of that header on every upstream request.'}
                {kind === 'QUERY_PARAM' && 'Added to the URL of every upstream request as ?name=value.'}
              </p>
            </div>
          )}

          <Button type="submit" disabled={isPending}>
            {isPending ? 'Saving…' : 'Save authentication'}
          </Button>
        </form>
      </CardContent>
    </Card>
  )
}
