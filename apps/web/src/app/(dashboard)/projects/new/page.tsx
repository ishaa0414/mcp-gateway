'use client'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { createProject } from '@/actions/projects'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { useState } from 'react'
import Link from 'next/link'
import { ArrowLeft } from 'lucide-react'

const schema = z.object({
  name: z.string().min(1, 'Name is required').max(100),
  slug: z
    .string()
    .regex(/^[a-z0-9-]{3,48}$/, 'Slug: 3–48 lowercase letters, numbers, hyphens'),
  upstreamBaseUrl: z.string().url('Must be a valid URL').or(z.literal('')),
})
type FormData = z.infer<typeof schema>

export default function NewProjectPage() {
  const [serverError, setServerError] = useState<string | null>(null)

  const {
    register,
    handleSubmit,
    setValue,
    watch,
    formState: { errors, isSubmitting },
  } = useForm<FormData>({
    resolver: zodResolver(schema),
    defaultValues: { upstreamBaseUrl: '' },
  })

  function autoSlug(name: string) {
    return name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48)
  }

  async function onSubmit(data: FormData) {
    setServerError(null)
    const fd = new FormData()
    fd.set('name', data.name)
    fd.set('slug', data.slug)
    fd.set('upstreamBaseUrl', data.upstreamBaseUrl)
    const result = await createProject(fd)
    if (result?.error) setServerError(result.error)
  }

  return (
    <div className="p-8">
      <div className="mb-6">
        <Link href="/projects" className="mb-4 flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
          <ArrowLeft className="h-4 w-4" />
          Back to projects
        </Link>
        <h1 className="text-2xl font-bold">New project</h1>
      </div>

      <Card className="max-w-lg">
        <CardHeader>
          <CardTitle>Project details</CardTitle>
          <CardDescription>Configure your new MCP Gateway project.</CardDescription>
        </CardHeader>
        <CardContent>
          {serverError && (
            <p className="mb-4 rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {serverError}
            </p>
          )}
          <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="name">Project name</Label>
              <Input
                id="name"
                placeholder="My API"
                {...register('name', {
                  onChange: (e) => setValue('slug', autoSlug(e.target.value)),
                })}
              />
              {errors.name && <p className="text-xs text-destructive">{errors.name.message}</p>}
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="slug">
                Slug{' '}
                <span className="ml-1 text-xs text-muted-foreground">(cannot be changed later)</span>
              </Label>
              <Input
                id="slug"
                placeholder="my-api"
                className="font-mono"
                {...register('slug')}
              />
              {errors.slug && <p className="text-xs text-destructive">{errors.slug.message}</p>}
              <p className="text-xs text-muted-foreground">
                Your MCP server will be at <code>/mcp/{watch('slug') || '…'}</code>
              </p>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="upstreamBaseUrl">
                Upstream base URL{' '}
                <span className="ml-1 text-xs text-muted-foreground">(optional, can be set after spec import)</span>
              </Label>
              <Input
                id="upstreamBaseUrl"
                placeholder="https://api.example.com"
                {...register('upstreamBaseUrl')}
              />
              {errors.upstreamBaseUrl && (
                <p className="text-xs text-destructive">{errors.upstreamBaseUrl.message}</p>
              )}
            </div>

            <Button type="submit" disabled={isSubmitting} className="w-full">
              {isSubmitting ? 'Creating…' : 'Create project'}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  )
}
