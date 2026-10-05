'use client'
import { useParams } from 'next/navigation'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { updateProjectSettings, deleteProject } from '@/actions/projects'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Separator } from '@/components/ui/separator'
import { useState, useTransition } from 'react'

const schema = z.object({
  name: z.string().min(1, 'Name is required').max(100),
  upstreamBaseUrl: z.string().url('Must be a valid URL').or(z.literal('')),
})
type FormData = z.infer<typeof schema>

export default function SettingsPage() {
  const { slug } = useParams<{ slug: string }>()
  const [isPending, startTransition] = useTransition()
  const [serverError, setServerError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const [deleteConfirm, setDeleteConfirm] = useState(false)
  const [deletePending, startDeleteTransition] = useTransition()

  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<FormData>({ resolver: zodResolver(schema) })

  async function onSubmit(data: FormData) {
    setServerError(null)
    setSaved(false)
    // We pass slug; the action uses it to find the project
    startTransition(async () => {
      const res = await updateProjectSettings(slug, data)
      if (res?.error) setServerError(res.error)
      else setSaved(true)
    })
  }

  function handleDelete() {
    if (!deleteConfirm) {
      setDeleteConfirm(true)
      return
    }
    startDeleteTransition(async () => {
      await deleteProject(slug)
    })
  }

  return (
    <div className="max-w-xl space-y-8">
      <Card>
        <CardHeader>
          <CardTitle>Project settings</CardTitle>
          <CardDescription>Update your project name and upstream URL.</CardDescription>
        </CardHeader>
        <CardContent>
          {serverError && (
            <p className="mb-4 rounded bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {serverError}
            </p>
          )}
          {saved && (
            <p className="mb-4 rounded bg-green-500/10 px-3 py-2 text-sm text-green-700 dark:text-green-400">
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
              <Input id="upstreamBaseUrl" {...register('upstreamBaseUrl')} />
              {errors.upstreamBaseUrl && (
                <p className="text-xs text-destructive">{errors.upstreamBaseUrl.message}</p>
              )}
            </div>
            <div className="space-y-1.5">
              <Label>Slug</Label>
              <Input value={slug} disabled className="font-mono text-sm" />
              <p className="text-xs text-muted-foreground">Slug cannot be changed after creation.</p>
            </div>
            <Button type="submit" disabled={isPending}>
              {isPending ? 'Saving…' : 'Save changes'}
            </Button>
          </form>
        </CardContent>
      </Card>

      <Separator />

      <Card className="border-destructive/50">
        <CardHeader>
          <CardTitle className="text-destructive">Danger zone</CardTitle>
          <CardDescription>Permanently delete this project and all its tools and logs.</CardDescription>
        </CardHeader>
        <CardContent>
          {deleteConfirm && (
            <p className="mb-3 text-sm text-destructive">
              This is irreversible. Click again to confirm deletion.
            </p>
          )}
          <Button
            variant="destructive"
            onClick={handleDelete}
            disabled={deletePending}
          >
            {deletePending ? 'Deleting…' : deleteConfirm ? 'Yes, delete project' : 'Delete project'}
          </Button>
        </CardContent>
      </Card>
    </div>
  )
}
