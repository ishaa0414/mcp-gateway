import { getProject } from '@/actions/projects'
import { getTools } from '@/actions/tools'
import { notFound } from 'next/navigation'
import { ToolList } from '@/components/tool-list'

interface Props {
  params: Promise<{ slug: string }>
}

export default async function ToolsPage({ params }: Props) {
  const { slug } = await params
  const [project, tools] = await Promise.all([getProject(slug), getTools(slug)])
  if (!project) notFound()

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold">Tools</h2>
        <p className="text-sm text-muted-foreground">
          Enable, disable, rename, or configure hidden parameters for each tool.
        </p>
      </div>
      {tools.length === 0 ? (
        <p className="py-8 text-center text-sm text-muted-foreground">
          No tools yet — import an OpenAPI spec on the Spec tab.
        </p>
      ) : (
        <ToolList tools={tools} projectSlug={slug} />
      )}
    </div>
  )
}
