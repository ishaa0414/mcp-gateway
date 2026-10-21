'use client'
import { ErrorPanel, type RouteErrorProps } from '@/components/error-panel'

/** An error in one tab of a project. The project header and the tabs stay, so the others are still one click away. */
export default function ProjectError({ error, retry }: RouteErrorProps) {
  return <ErrorPanel error={error} retry={retry} />
}
