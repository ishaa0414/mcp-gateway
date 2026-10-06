import Link from 'next/link'
import { CopyButton } from '@/components/copy-button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'

function Command({ children }: { children: string }) {
  return (
    <div className="flex items-start justify-between gap-2 rounded-md bg-muted px-3 py-2">
      <code className="break-all text-xs">{children}</code>
      <CopyButton value={children} className="shrink-0" />
    </div>
  )
}

/** How to reach this project's MCP endpoint, with the real URL filled in. */
export function ConnectionSnippet({ url, slug }: { url: string; slug: string }) {
  const cli = `npx @modelcontextprotocol/inspector --cli ${url} --transport http --header "Authorization: Bearer <your-api-key>" --method tools/list`

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Connect an agent</CardTitle>
        <CardDescription>Streamable HTTP. Every request needs one of this project&apos;s API keys.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="space-y-1.5">
          <p className="text-xs font-medium text-muted-foreground">MCP URL</p>
          <Command>{url}</Command>
        </div>

        <div className="space-y-2">
          <p className="text-xs font-medium text-muted-foreground">Try it with MCP Inspector</p>
          <ol className="list-decimal space-y-2 pl-5 text-sm">
            <li>
              Create a key on the{' '}
              <Link href={`/projects/${slug}/api-keys`} className="underline underline-offset-2">
                API Keys
              </Link>{' '}
              tab and copy it.
            </li>
            <li>
              Start the Inspector (needs Node 22.19 or newer):
              <div className="mt-1.5">
                <Command>npx @modelcontextprotocol/inspector</Command>
              </div>
            </li>
            <li>
              Set <strong>Transport Type</strong> to <strong>Streamable HTTP</strong>, paste the URL above, and add the header{' '}
              <code className="text-xs">Authorization</code> with the value <code className="text-xs">Bearer &lt;your-api-key&gt;</code>.
            </li>
            <li>
              Click <strong>Connect</strong>, then open <strong>Tools</strong> and <strong>List Tools</strong>.
            </li>
          </ol>
        </div>

        <div className="space-y-1.5">
          <p className="text-xs font-medium text-muted-foreground">Or from a terminal</p>
          <Command>{cli}</Command>
        </div>
      </CardContent>
    </Card>
  )
}
