import { notFound } from 'next/navigation'
import { getCredentialSummary } from '@/actions/credentials'
import { getProject } from '@/actions/projects'
import { CredentialsForm } from '@/components/credentials-form'
import { DeleteProjectCard } from '@/components/delete-project-card'
import { SettingsForm } from '@/components/settings-form'
import { Separator } from '@/components/ui/separator'

export default async function SettingsPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params
  const project = await getProject(slug)
  if (!project) notFound()
  const credential = await getCredentialSummary(slug)

  return (
    <div className="max-w-xl space-y-8">
      <SettingsForm
        slug={slug}
        initial={{ name: project.name, upstreamBaseUrl: project.upstreamBaseUrl }}
      />
      <CredentialsForm slug={slug} summary={credential} />
      <Separator />
      <DeleteProjectCard slug={slug} />
    </div>
  )
}
