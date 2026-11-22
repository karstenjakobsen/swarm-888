import { operatorMode } from '@/lib/operator/mode'
import { getLog } from '@/lib/operator/server-log'

export const dynamic = 'force-dynamic'

export async function GET() {
  if (operatorMode() !== 'demo') return new Response(null, { status: 503 })
  const log = getLog()
  log.begin()
  const events = log.readAfter(0)
  return Response.json(
    { events, cursor: events.at(-1)?.seq ?? 0, epoch: log.epoch },
    { headers: { 'Cache-Control': 'no-store' } },
  )
}
