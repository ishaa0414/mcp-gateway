import Link from 'next/link'
import { CopyButton } from '@/components/copy-button'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'

/** The project's MCP URL, with a way to the full connection guides (the Connect tab). */
export function ConnectionSnippet({ url, slug }: { url: string; slug: string }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Connect an agent</CardTitle>
        <CardDescription>Streamable HTTP. Every request needs one of this project&apos;s API keys.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="space-y-1.5">
          <p className="text-xs font-medium text-muted-foreground">MCP URL</p>
          <div className="flex items-start justify-between gap-2 rounded-md bg-muted px-3 py-2">
            <code className="break-all text-xs">{url}</code>
            <CopyButton value={url} className="shrink-0" />
          </div>
        </div>
        <Button asChild variant="outline" size="sm">
          <Link href={`/projects/${slug}/connect`}>Connection guides: Claude Code, Cursor, VS Code, Inspector</Link>
        </Button>
      </CardContent>
    </Card>
  )
}
