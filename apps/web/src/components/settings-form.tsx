'use client'
import { useState, useTransition } from 'react'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { updateProjectSettings } from '@/actions/projects'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'

// Syntax only; the server also rejects private/internal hosts (SSRF) on save.
const schema = z.object({
  name: z.string().trim().min(1, 'Name is required').max(100),
  upstreamBaseUrl: z
    .string()
    .trim()
    .refine((v) => v === '' || /^https?:\/\/[^/\s]/i.test(v), {
      message: 'Must be an absolute URL starting with http:// or https://',
    }),
})
type FormValues = z.infer<typeof schema>

interface SettingsFormProps {
  slug: string
  initial: FormValues
}

export function SettingsForm({ slug, initial }: SettingsFormProps) {
  const [isPending, startTransition] = useTransition()
  const [serverError, setServerError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  const {
    register,
    handleSubmit,
    reset,
    formState: { errors, dirtyFields, isDirty },
  } = useForm<FormValues>({ resolver: zodResolver(schema), defaultValues: initial })

  function onSubmit(values: FormValues) {
    setServerError(null)
    setSaved(false)

    // Send only what the user changed so an untouched field can never be overwritten.
    const changes: Partial<FormValues> = {}
    if (dirtyFields.name) changes.name = values.name
    if (dirtyFields.upstreamBaseUrl) changes.upstreamBaseUrl = values.upstreamBaseUrl

    startTransition(async () => {
      const res = await updateProjectSettings(slug, changes)
      if (res.error) {
        setServerError(res.error)
      } else if (res.project) {
        reset(res.project)
        setSaved(true)
      }
    })
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Project settings</CardTitle>
        <CardDescription>Update your project name and upstream URL.</CardDescription>
      </CardHeader>
      <CardContent>
        {serverError && (
          <p role="alert" className="mb-4 rounded bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {serverError}
          </p>
        )}
        {saved && (
          <p role="status" className="mb-4 rounded bg-green-500/10 px-3 py-2 text-sm text-green-700 dark:text-green-400">
            Settings saved.
          </p>
        )}
        <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="name">Name</Label>
            <Input id="name" {...register('name')} />
            {errors.name && <p className="text-xs text-destructive">{errors.name.message}</p>}
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="upstreamBaseUrl">Upstream base URL</Label>
            <Input
              id="upstreamBaseUrl"
              placeholder="https://api.example.com/v1"
              {...register('upstreamBaseUrl')}
            />
            {errors.upstreamBaseUrl ? (
              <p className="text-xs text-destructive">{errors.upstreamBaseUrl.message}</p>
            ) : initial.upstreamBaseUrl === '' && !dirtyFields.upstreamBaseUrl ? (
              <p className="text-xs text-amber-700 dark:text-amber-400">
                Not set. Tool calls need an absolute URL here before they can reach your API.
              </p>
            ) : null}
          </div>
          <div className="space-y-1.5">
            <Label>Slug</Label>
            <Input value={slug} disabled className="font-mono text-sm" />
            <p className="text-xs text-muted-foreground">Slug cannot be changed after creation.</p>
          </div>
          <Button type="submit" disabled={isPending || !isDirty}>
            {isPending ? 'Saving…' : 'Save changes'}
          </Button>
        </form>
      </CardContent>
    </Card>
  )
}
