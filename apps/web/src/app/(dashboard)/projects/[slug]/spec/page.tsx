'use client'
import { useState, useTransition } from 'react'
import { useParams } from 'next/navigation'
import { importSpecFromFile, importSpecFromUrl } from '@/actions/spec'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Badge } from '@/components/ui/badge'
import Link from 'next/link'
import { Upload, Globe, CheckCircle, AlertCircle } from 'lucide-react'
import type { BaseUrlOutcome, ImportResult } from '@/lib/spec-import'

function baseUrlMessage(outcome: BaseUrlOutcome): string | null {
  switch (outcome.status) {
    case 'kept':
      return null
    case 'set':
      return `Upstream base URL set to ${outcome.url}.`
    case 'unset':
      if (outcome.reason === 'relative')
        return 'This spec declares a relative server URL, so no upstream base URL was set.'
      if (outcome.reason === 'none') return 'This spec declares no servers, so no upstream base URL was set.'
      return `The spec's server URL was not used (${outcome.detail ?? 'rejected'}).`
  }
}

export default function SpecPage() {
  const { slug } = useParams<{ slug: string }>()
  const [isPending, startTransition] = useTransition()
  const [result, setResult] = useState<ImportResult | null>(null)
  const [urlValue, setUrlValue] = useState('')

  function handleFileSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const fd = new FormData(e.currentTarget)
    startTransition(async () => {
      const res = await importSpecFromFile(slug, fd)
      setResult(res)
    })
  }

  function handleUrlSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    startTransition(async () => {
      const res = await importSpecFromUrl(slug, urlValue)
      setResult(res)
    })
  }

  return (
    <div className="max-w-xl space-y-6">
      <div>
        <h2 className="text-lg font-semibold">OpenAPI Spec</h2>
        <p className="text-sm text-muted-foreground">
          Import or re-import your OpenAPI 3.0 / 3.1 spec. Existing tool edits are preserved.
        </p>
      </div>

      {result && (
        <div
          className={`flex items-start gap-3 rounded-lg border p-4 ${
            'error' in result ? 'border-destructive/50 bg-destructive/5' : 'border-green-500/50 bg-green-500/5'
          }`}
        >
          {'error' in result ? (
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
          ) : (
            <CheckCircle className="mt-0.5 h-4 w-4 shrink-0 text-green-500" />
          )}
          <div className="text-sm">
            {'error' in result ? (
              <p className="text-destructive">{result.error}</p>
            ) : (
              <>
                <p className="font-medium text-green-700 dark:text-green-400">Import successful</p>
                <div className="mt-1 flex flex-wrap gap-2 text-xs text-muted-foreground">
                  <Badge variant="secondary">{result.added} added</Badge>
                  <Badge variant="secondary">{result.updated} updated</Badge>
                  <Badge variant="secondary">{result.removed} removed</Badge>
                  <Badge variant="secondary">{result.unchanged} unchanged</Badge>
                  <Badge variant="secondary">{result.total} total</Badge>
                </div>
                {baseUrlMessage(result.baseUrl) && (
                  <p className="mt-2 text-xs text-muted-foreground">{baseUrlMessage(result.baseUrl)}</p>
                )}
                {result.baseUrl.status === 'unset' && (
                  <p className="mt-1 text-xs font-medium text-amber-700 dark:text-amber-400">
                    Set the upstream base URL in{' '}
                    <Link href={`/projects/${slug}/settings`} className="underline underline-offset-2">
                      Settings
                    </Link>{' '}
                    before connecting an agent.
                  </p>
                )}
              </>
            )}
          </div>
        </div>
      )}

      <Tabs defaultValue="file">
        <TabsList>
          <TabsTrigger value="file">
            <Upload className="mr-1.5 h-3.5 w-3.5" />
            Upload file
          </TabsTrigger>
          <TabsTrigger value="url">
            <Globe className="mr-1.5 h-3.5 w-3.5" />
            Fetch URL
          </TabsTrigger>
        </TabsList>

        <TabsContent value="file">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Upload spec file</CardTitle>
              <CardDescription>JSON or YAML, max 5 MB</CardDescription>
            </CardHeader>
            <CardContent>
              <form onSubmit={handleFileSubmit} className="space-y-4">
                <div className="space-y-1.5">
                  <Label htmlFor="spec">File</Label>
                  <Input
                    id="spec"
                    name="spec"
                    type="file"
                    accept=".json,.yaml,.yml"
                    required
                  />
                </div>
                <Button type="submit" disabled={isPending}>
                  {isPending ? 'Importing…' : 'Import'}
                </Button>
              </form>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="url">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Fetch from URL</CardTitle>
              <CardDescription>Publicly accessible URL to your OpenAPI spec</CardDescription>
            </CardHeader>
            <CardContent>
              <form onSubmit={handleUrlSubmit} className="space-y-4">
                <div className="space-y-1.5">
                  <Label htmlFor="specUrl">URL</Label>
                  <Input
                    id="specUrl"
                    type="url"
                    placeholder="https://api.example.com/openapi.json"
                    value={urlValue}
                    onChange={(e) => setUrlValue(e.target.value)}
                    required
                  />
                </div>
                <Button type="submit" disabled={isPending || !urlValue}>
                  {isPending ? 'Fetching…' : 'Fetch and import'}
                </Button>
              </form>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  )
}
