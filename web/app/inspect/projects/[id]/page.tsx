import type { Metadata } from 'next'
import { ProjectView } from '@/components/operator/project-view'

export const metadata: Metadata = { title: 'Project · Operator' }

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  return <ProjectView id={id} />
}
