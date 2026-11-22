import { SkillView } from '@/components/operator/skill-view'

export default async function Page({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>
  searchParams: Promise<{ rev?: string }>
}) {
  const [{ id }, { rev }] = await Promise.all([params, searchParams])
  return <SkillView id={id} rev={rev} />
}
