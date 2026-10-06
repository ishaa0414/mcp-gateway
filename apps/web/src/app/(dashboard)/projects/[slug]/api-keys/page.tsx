import { notFound } from 'next/navigation'
import { listApiKeys } from '@/actions/api-keys'
import { getProject } from '@/actions/projects'
import { ApiKeysPanel } from '@/components/api-keys-panel'

export default async function ApiKeysPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params
  const project = await getProject(slug)
  if (!project) notFound()

  return <ApiKeysPanel slug={slug} keys={await listApiKeys(slug)} />
}
