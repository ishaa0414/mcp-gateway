'use client'
import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { createApiKey, revokeApiKey, type ApiKeySummary } from '@/actions/api-keys'
import { CopyButton } from '@/components/copy-button'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { KeyRound, Plus } from 'lucide-react'

// Fixed format so the server render and the browser agree (no locale or time zone differences).
const when = (iso: string) => `${iso.slice(0, 16).replace('T', ' ')} UTC`

interface ApiKeysPanelProps {
  slug: string
  keys: ApiKeySummary[]
}

export function ApiKeysPanel({ slug, keys }: ApiKeysPanelProps) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()

  const [createOpen, setCreateOpen] = useState(false)
  const [name, setName] = useState('')
  const [rateLimit, setRateLimit] = useState('60')
  const [createError, setCreateError] = useState<string | null>(null)

  // The full key exists in the browser only between creation and the user closing this dialog.
  const [revealed, setRevealed] = useState<{ name: string; key: string } | null>(null)

  const [revoking, setRevoking] = useState<ApiKeySummary | null>(null)
  const [revokeError, setRevokeError] = useState<string | null>(null)

  function openCreate() {
    setName('')
    setRateLimit('60')
    setCreateError(null)
    setCreateOpen(true)
  }

  function handleCreate(e: React.FormEvent) {
    e.preventDefault()
    setCreateError(null)
    startTransition(async () => {
      const res = await createApiKey(slug, { name, rateLimitPerMin: rateLimit })
      if (res.error || !res.key) {
        setCreateError(res.error ?? 'Could not create the key')
        return
      }
      setCreateOpen(false)
      setRevealed({ name: res.apiKey?.name ?? name, key: res.key })
      router.refresh()
    })
  }

  function handleRevoke() {
    if (!revoking) return
    setRevokeError(null)
    startTransition(async () => {
      const res = await revokeApiKey(slug, revoking.id)
      if (res.error) {
        setRevokeError(res.error)
        return
      }
      setRevoking(null)
      router.refresh()
    })
  }

  const active = keys.filter((k) => !k.revokedAt)
  const revoked = keys.filter((k) => k.revokedAt)

  return (
    <div className="max-w-3xl space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-lg font-semibold">API keys</h2>
          <p className="text-sm text-muted-foreground">
            Each agent or customer connects with its own key, sent as <code className="text-xs">Authorization: Bearer &lt;key&gt;</code>. A
            key only works for this project and can be revoked at any time.
          </p>
        </div>
        <Button onClick={openCreate}>
          <Plus className="mr-2 h-4 w-4" />
          Create key
        </Button>
      </div>

      {keys.length === 0 ? (
        <div className="flex flex-col items-center rounded-lg border border-dashed py-12">
          <KeyRound className="mb-3 h-6 w-6 text-muted-foreground" />
          <p className="mb-1 text-sm font-medium">No API keys yet</p>
          <p className="mb-4 text-sm text-muted-foreground">Create one to connect an agent to this project.</p>
          <Button variant="outline" size="sm" onClick={openCreate}>
            Create your first key
          </Button>
        </div>
      ) : (
        <Card>
          <CardContent className="p-0">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-xs text-muted-foreground">
                  <th className="px-4 py-2 font-medium">Name</th>
                  <th className="px-4 py-2 font-medium">Key</th>
                  <th className="px-4 py-2 font-medium">Created</th>
                  <th className="px-4 py-2 font-medium">Last used</th>
                  <th className="px-4 py-2" />
                </tr>
              </thead>
              <tbody className="divide-y">
                {[...active, ...revoked].map((k) => (
                  <tr key={k.id} className={k.revokedAt ? 'text-muted-foreground' : undefined}>
                    <td className="px-4 py-3">
                      <div className="font-medium">{k.name}</div>
                      <div className="text-xs text-muted-foreground">{k.rateLimitPerMin} requests/min</div>
                    </td>
                    <td className="px-4 py-3 font-mono text-xs">{k.prefix}</td>
                    <td className="px-4 py-3 text-xs">{when(k.createdAt)}</td>
                    <td className="px-4 py-3 text-xs">{k.lastUsedAt ? when(k.lastUsedAt) : 'Never'}</td>
                    <td className="px-4 py-3 text-right">
                      {k.revokedAt ? (
                        <Badge variant="secondary">Revoked</Badge>
                      ) : (
                        <Button
                          variant="ghost"
                          size="sm"
                          className="text-destructive hover:text-destructive"
                          onClick={() => {
                            setRevokeError(null)
                            setRevoking(k)
                          }}
                        >
                          Revoke
                        </Button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </CardContent>
        </Card>
      )}

      {/* Create */}
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Create an API key</DialogTitle>
            <DialogDescription>You will see the key once, right after creating it.</DialogDescription>
          </DialogHeader>
          <form onSubmit={handleCreate} className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="keyName">Name</Label>
              <Input
                id="keyName"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Claude Desktop (Alice)"
                maxLength={60}
                autoFocus
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="rateLimit">Rate limit (requests per minute)</Label>
              <Input
                id="rateLimit"
                type="number"
                min={1}
                max={10000}
                value={rateLimit}
                onChange={(e) => setRateLimit(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">Not enforced yet: rate limiting arrives in a later release. The value is saved with the key.</p>
            </div>
            {createError && (
              <p role="alert" className="text-sm text-destructive">
                {createError}
              </p>
            )}
            <div className="flex justify-end gap-2">
              <Button type="button" variant="outline" onClick={() => setCreateOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={isPending || name.trim() === ''}>
                {isPending ? 'Creating…' : 'Create key'}
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>

      {/* One-time reveal: closing it is the only way out, so the key cannot be dismissed by accident. */}
      <Dialog open={revealed !== null} onOpenChange={() => undefined}>
        <DialogContent onInteractOutside={(e) => e.preventDefault()} onEscapeKeyDown={(e) => e.preventDefault()}>
          <DialogHeader>
            <DialogTitle>Copy your API key</DialogTitle>
            <DialogDescription>
              This is the only time <strong>{revealed?.name}</strong> is shown in full. Store it somewhere safe. If you lose it, revoke
              it and create a new one.
            </DialogDescription>
          </DialogHeader>
          <div className="flex items-center gap-2">
            <Input readOnly value={revealed?.key ?? ''} aria-label="New API key" className="font-mono text-xs" onFocus={(e) => e.target.select()} />
            <CopyButton value={revealed?.key ?? ''} />
          </div>
          <div className="flex justify-end">
            <Button onClick={() => setRevealed(null)}>I have saved it</Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Revoke */}
      <Dialog open={revoking !== null} onOpenChange={(open) => !open && setRevoking(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Revoke this key?</DialogTitle>
            <DialogDescription>
              <strong>{revoking?.name}</strong> ({revoking?.prefix}) stops working immediately. Agents using it will get a 401. This
              cannot be undone.
            </DialogDescription>
          </DialogHeader>
          {revokeError && (
            <p role="alert" className="text-sm text-destructive">
              {revokeError}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setRevoking(null)}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={handleRevoke} disabled={isPending}>
              {isPending ? 'Revoking…' : 'Revoke key'}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}
