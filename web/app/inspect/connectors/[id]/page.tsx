import { ConnectorView } from '@/components/operator/connector-view'

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  return <ConnectorView id={id} />
}
