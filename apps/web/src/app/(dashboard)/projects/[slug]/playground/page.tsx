import Link from 'next/link'
import { notFound } from 'next/navigation'
import { getProject } from '@/actions/projects'
import { PlaygroundPanel } from '@/components/playground/playground-panel'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { db } from '@/lib/db'
import { env } from '@/lib/env'
import { playgroundTools } from '@/lib/playground/tools'

interface Props {
  params: Promise<{ slug: string }>
}

export default async function PlaygroundPage({ params }: Props) {
  const { slug } = await params
  const project = await getProject(slug)
  if (!project) notFound()

  const heading = (
    <div>
      <h2 className="text-lg font-semibold">Playground</h2>
      <p className="text-sm text-muted-foreground">Try a tool on your real API and see the exact request and response.</p>
    </div>
  )

  if (!env().PLAYGROUND_SECRET) {
    return (
      <div className="max-w-2xl space-y-4">
        {heading}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Playground not configured</CardTitle>
            <CardDescription>The dashboard and the gateway sign playground requests with a shared secret, and none is set here.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <p>
              Set <code className="text-xs">PLAYGROUND_SECRET</code> to the same value (at least 32 bytes) for the dashboard and the gateway, then restart
              both. Generate one with <code className="text-xs">openssl rand -hex 32</code>. If the dashboard reaches the gateway on a different address
              than agents do, also set <code className="text-xs">GATEWAY_INTERNAL_URL</code>. See <code className="text-xs">.env.example</code>.
            </p>
          </CardContent>
        </Card>
      </div>
    )
  }

  const tools = await playgroundTools({ userId: project.userId, slug })
  if (!tools) notFound()

  if (tools.length === 0) {
    return (
      <div className="max-w-2xl space-y-4">
        {heading}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">No enabled tools</CardTitle>
            <CardDescription>The playground runs the tools that are switched on.</CardDescription>
          </CardHeader>
          <CardContent>
            <Button asChild variant="outline">
              <Link href={`/projects/${slug}/tools`}>Go to Tools</Link>
            </Button>
          </CardContent>
        </Card>
      </div>
    )
  }

  // Only whether a credential exists, to word the notes; its type and value stay on the server.
  const credential = await db.upstreamCredential.findUnique({ where: { projectId: project.id }, select: { type: true } })

  return (
    <div className="space-y-4">
      {heading}
      <PlaygroundPanel slug={slug} tools={tools} hasCredential={credential !== null && credential.type !== 'NONE'} />
    </div>
  )
}
