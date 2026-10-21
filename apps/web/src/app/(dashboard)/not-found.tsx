import { NotFoundPanel } from '@/components/not-found-panel'

/** notFound() inside the dashboard. The words are the same for a project that does not exist and one that is not yours. */
export default function DashboardNotFound() {
  return <NotFoundPanel title="Not found" message="We could not find that. It may not exist, or you may not have access to it." />
}
