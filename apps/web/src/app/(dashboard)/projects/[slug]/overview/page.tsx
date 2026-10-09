import { getProject } from '@/actions/projects'
import { getTools } from '@/actions/tools'
import { notFound } from 'next/navigation'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import Link from 'next/link'
import { Button } from '@/components/ui/button'
import { ConnectionSnippet } from '@/components/connection-snippet'
import { env } from '@/lib/env'
import { mcpEndpointUrl } from '@/lib/mcp-url'

interface Props {
  params: Promise<{ slug: string }>
}

export default async function OverviewPage({ params }: Props) {
  const { slug } = await params
  const [project, tools] = await Promise.all([getProject(slug), getTools(slug)])
  if (!project) notFound()

  const enabledTools = tools.filter((t) => t.enabled && !t.removedAt)
  const disabledTools = tools.filter((t) => !t.enabled && !t.removedAt)
  const removedTools = tools.filter((t) => t.removedAt)

  return (
    <div className="max-w-2xl space-y-6">
      <div className="grid grid-cols-3 gap-4">
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-sm font-medium text-muted-foreground">Enabled tools</CardTitle></CardHeader>
          <CardContent><p className="text-3xl font-bold">{enabledTools.length}</p></CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-sm font-medium text-muted-foreground">Disabled</CardTitle></CardHeader>
          <CardContent><p className="text-3xl font-bold">{disabledTools.length}</p></CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-sm font-medium text-muted-foreground">Removed</CardTitle></CardHeader>
          <CardContent><p className="text-3xl font-bold">{removedTools.length}</p></CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader><CardTitle className="text-base">Connection details</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          <div>
            <p className="text-xs font-medium text-muted-foreground">Upstream base URL</p>
            <code className="mt-1 block rounded bg-muted px-2 py-1 text-sm">
              {project.upstreamBaseUrl || <span className="text-muted-foreground">Not set</span>}
            </code>
          </div>
          {project.specVersion && (
            <div>
              <p className="text-xs font-medium text-muted-foreground">Spec version</p>
              <Badge variant="secondary" className="mt-1">{project.specVersion}</Badge>
            </div>
          )}
        </CardContent>
      </Card>

      <ConnectionSnippet url={mcpEndpointUrl(env().GATEWAY_PUBLIC_URL, project.slug)} slug={project.slug} />

      {tools.length === 0 && (
        <div className="flex flex-col items-center rounded-lg border border-dashed py-10">
          <p className="mb-3 text-sm text-muted-foreground">No spec imported yet</p>
          <Button asChild variant="outline" size="sm">
            <Link href={`/projects/${slug}/spec`}>Import OpenAPI spec</Link>
          </Button>
        </div>
      )}
    </div>
  )
}
