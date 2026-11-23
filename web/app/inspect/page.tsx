import type { Metadata } from 'next'
import { InspectView, type InspectTab } from '@/components/operator/inspect-view'

export const metadata: Metadata = { title: 'Inspect · Operator' }

export default async function Page({ searchParams }: { searchParams: Promise<{ tab?: string }> }) {
  const { tab } = await searchParams
  const t: InspectTab = tab === 'skills' || tab === 'connectors' || tab === 'projects' || tab === 'worker' || tab === 'catalog' ? tab : 'memory'
  return <InspectView tab={t} />
}
