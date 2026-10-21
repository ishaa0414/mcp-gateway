import Link from 'next/link'
import { notFound } from 'next/navigation'
import { getProject } from '@/actions/projects'
import { CodeBlock } from '@/components/connect/code-block'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { apiKeyEnvName } from '@/lib/connect/env-name'
import { buildGuides, CLAUDE_CONNECTORS_DOC, DOCS_CHECKED, envBlocks, FETCH_FAILED_HELP, lengthCheckBlocks } from '@/lib/connect/snippets'
import { env } from '@/lib/env'
import { mcpEndpointUrl } from '@/lib/mcp-url'

interface Props {
  params: Promise<{ slug: string }>
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]'])

function DocLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noreferrer" className="underline underline-offset-2">
      {children}
    </a>
  )
}

export default async function ConnectPage({ params }: Props) {
  const { slug } = await params
  const project = await getProject(slug)
  if (!project) notFound()

  const url = mcpEndpointUrl(env().GATEWAY_PUBLIC_URL, project.slug)
  const keyVar = apiKeyEnvName(project.slug)
  const guides = buildGuides({ url, slug: project.slug })
  const isLocal = LOCAL_HOSTS.has(new URL(url).hostname)

  return (
    <div className="max-w-3xl space-y-6">
      <div>
        <h2 className="text-lg font-semibold">Connect an agent</h2>
        <p className="text-sm text-muted-foreground">Copy-paste setup for the clients that speak Streamable HTTP. Every request needs one of this project&apos;s API keys.</p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">MCP URL</CardTitle>
          {isLocal && (
            <CardDescription>
              This address only works on this machine. Set <code className="text-xs">GATEWAY_PUBLIC_URL</code> to the gateway&apos;s public address to share it.
            </CardDescription>
          )}
        </CardHeader>
        <CardContent>
          <CodeBlock label="Streamable HTTP endpoint" text={url} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Your API key</CardTitle>
          <CardDescription>
            The snippets below never contain a key. Create one on the{' '}
            <Link href={`/projects/${project.slug}/api-keys`} className="underline underline-offset-2">
              API Keys
            </Link>{' '}
            tab (it is shown once), then keep it in the environment variable <code className="text-xs">{keyVar}</code>. Run the line for your shell and paste the
            key when asked; nothing is shown while you type, and the key stays out of your shell history. It lasts for that terminal window only.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {envBlocks(project.slug).map((block) => (
            <CodeBlock key={block.label} label={block.label} text={block.text} />
          ))}
          <p className="text-xs text-muted-foreground">
            Prefer environment or input variables, as these snippets do, so a key is never committed in a project file.
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Troubleshooting</CardTitle>
          <CardDescription>{FETCH_FAILED_HELP}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {lengthCheckBlocks(project.slug).map((block) => (
            <CodeBlock key={block.label} label={`Check the length: ${block.label}`} text={block.text} />
          ))}
        </CardContent>
      </Card>

      {guides.map((guide) => (
        <Card key={guide.id}>
          <CardHeader>
            <CardTitle className="text-base">{guide.title}</CardTitle>
            {guide.intro.map((line) => (
              <CardDescription key={line}>{line}</CardDescription>
            ))}
          </CardHeader>
          <CardContent className="space-y-3">
            {guide.blocks.map((block) => (
              <CodeBlock key={block.label} label={block.label} text={block.text} />
            ))}
            {guide.notes.map((note) => (
              <p key={note} className="text-xs text-muted-foreground">
                {note}
              </p>
            ))}
            <p className="text-xs text-muted-foreground">
              Format from <DocLink href={guide.docUrl}>{guide.docLabel}</DocLink>.
            </p>
          </CardContent>
        </Card>
      ))}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Claude Desktop and claude.ai</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          <p>
            Custom connectors in Claude Desktop and claude.ai sign in with OAuth. A fixed API key sent as a request header is a beta feature for a limited set of organizations, and this
            gateway uses API keys, not OAuth. Use Claude Code above for Claude. See{' '}
            <DocLink href={CLAUDE_CONNECTORS_DOC}>Authentication for connectors</DocLink>.
          </p>
        </CardContent>
      </Card>

      <p className="text-xs text-muted-foreground">Formats last compared with the linked pages on {DOCS_CHECKED}; clients change them, so the linked page wins.</p>
    </div>
  )
}
