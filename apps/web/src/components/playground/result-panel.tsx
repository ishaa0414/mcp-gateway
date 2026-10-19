'use client'
import { CopyButton } from '@/components/copy-button'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { describeResult, type PlaygroundResult, type PlaygroundRun, type RequestPreview, type ResponsePreview } from '@/lib/playground/result'

/** Pretty-print a JSON body for reading; anything else (or a body cut short) is shown as it is. */
function readable(body: string, contentType: string | undefined): string {
  if (!contentType?.toLowerCase().includes('json')) return body
  try {
    return JSON.stringify(JSON.parse(body), null, 2)
  } catch {
    return body
  }
}

function Headers({ headers }: { headers: Record<string, string> }) {
  const entries = Object.entries(headers)
  if (entries.length === 0) return <p className="text-xs text-muted-foreground">No headers.</p>
  return (
    <dl className="space-y-0.5 font-mono text-xs">
      {entries.map(([name, value]) => (
        <div key={name} className="flex gap-2">
          <dt className="shrink-0 text-muted-foreground">{name}:</dt>
          <dd className="break-all">{value}</dd>
        </div>
      ))}
    </dl>
  )
}

/** Text only, as a text node: never interpreted as HTML. */
function Text({ children, label }: { children: string; label: string }) {
  return (
    <pre aria-label={label} className="max-h-96 overflow-auto whitespace-pre-wrap break-all rounded-md bg-muted p-3 font-mono text-xs">
      {children}
    </pre>
  )
}

function RequestSection({ request }: { request: RequestPreview }) {
  return (
    <section className="space-y-2" aria-label="Request">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-medium">Request</h3>
        <CopyButton value={request.url} label="Copy URL" />
      </div>
      <p className="break-all font-mono text-xs">
        <span className="font-semibold">{request.method}</span> {request.url}
      </p>
      <Headers headers={request.headers} />
      {request.body !== undefined && <Text label="Request body">{readable(request.body, request.headers['content-type'])}</Text>}
      <p className="text-xs text-muted-foreground">Your stored credential and hidden parameters are hidden here; the real request carries them.</p>
    </section>
  )
}

function ResponseSection({ response }: { response: ResponsePreview }) {
  const contentType = response.headers['content-type']
  return (
    <section className="space-y-2" aria-label="Response">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-medium">Response</h3>
        {response.body !== undefined && <CopyButton value={response.body} label="Copy body" />}
      </div>
      <p className="text-xs">
        HTTP <span className="font-semibold">{response.status}</span> · {response.bodyBytes} byte{response.bodyBytes === 1 ? '' : 's'}
      </p>
      <Headers headers={response.headers} />
      {response.binary && (
        <p className="text-sm text-muted-foreground">
          The body is binary ({contentType ?? 'unknown type'}, {response.bodyBytes} bytes) and is not shown.
        </p>
      )}
      {response.body !== undefined && <Text label="Response body">{readable(response.body, contentType)}</Text>}
      {response.body === undefined && !response.binary && <p className="text-sm text-muted-foreground">The response has no body.</p>}
      {response.truncated && <p className="text-xs text-muted-foreground">The body is long and was cut for display.</p>}
    </section>
  )
}

function RunSummary({ run }: { run: PlaygroundRun }) {
  const status = run.response?.status
  return (
    <div className="flex flex-wrap items-center gap-2 text-sm">
      <Badge variant={run.ok ? 'default' : 'destructive'}>{run.ok ? 'Success' : 'Failed'}</Badge>
      {status !== undefined && <span>HTTP {status}</span>}
      <span className="text-muted-foreground">{run.latencyMs} ms</span>
      {!run.ok && run.errorClass && <span className="text-muted-foreground">({run.errorClass})</span>}
    </div>
  )
}

export function ResultPanel({ result }: { result: PlaygroundResult }) {
  if (result.status !== 'ok') {
    const warning = result.status === 'invalid' || result.status === 'rate_limited'
    return (
      <div role="alert" className={`rounded-md border p-3 text-sm ${warning ? 'border-yellow-500/40 bg-yellow-500/10' : 'border-destructive/40 bg-destructive/10'}`}>
        {describeResult(result)}
      </div>
    )
  }

  const { run } = result
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">Result</CardTitle>
      </CardHeader>
      <CardContent className="space-y-5">
        <RunSummary run={run} />
        {!run.ok && run.message && (
          <p role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm">
            {run.message}
          </p>
        )}
        {run.request ? <RequestSection request={run.request} /> : <p className="text-sm text-muted-foreground">No request was made.</p>}
        {run.response && <ResponseSection response={run.response} />}
      </CardContent>
    </Card>
  )
}
