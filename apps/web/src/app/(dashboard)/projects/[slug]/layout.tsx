import { getProject } from '@/actions/projects'
import { notFound } from 'next/navigation'
import Link from 'next/link'
import { ArrowLeft } from 'lucide-react'
import { ProjectNav } from '@/components/project-nav'

interface Props {
  children: React.ReactNode
  params: Promise<{ slug: string }>
}

export default async function ProjectLayout({ children, params }: Props) {
  const { slug } = await params
  const project = await getProject(slug)
  if (!project) notFound()

  return (
    <div className="flex h-full flex-col">
      <div className="border-b px-4 pt-4 pb-0 md:px-8 md:pt-6">
        <Link
          href="/projects"
          className="mb-3 flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          Projects
        </Link>
        <div className="mb-4 min-w-0">
          <h1 className="truncate text-xl font-semibold">{project.name}</h1>
          <p className="truncate font-mono text-xs text-muted-foreground">{project.slug}</p>
        </div>
        <ProjectNav slug={slug} />
      </div>
      <div className="min-w-0 flex-1 overflow-y-auto p-4 md:p-8">{children}</div>
    </div>
  )
}
