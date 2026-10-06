import { notFound } from 'next/navigation'
import { getProject } from '@/actions/projects'
import { DeleteProjectCard } from '@/components/delete-project-card'
import { SettingsForm } from '@/components/settings-form'
import { Separator } from '@/components/ui/separator'

export default async function SettingsPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params
  const project = await getProject(slug)
  if (!project) notFound()

  return (
    <div className="max-w-xl space-y-8">
      <SettingsForm
        slug={slug}
        initial={{ name: project.name, upstreamBaseUrl: project.upstreamBaseUrl }}
      />
      <Separator />
      <DeleteProjectCard slug={slug} />
    </div>
  )
}
