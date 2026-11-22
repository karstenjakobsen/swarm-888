import { getLog } from '@/lib/operator/server-log'

export const dynamic = 'force-dynamic'

// Public demo: this endpoint never accepts credential values. The server substitutes placeholders.
export async function POST(req: Request) {
  let body: unknown
  try {
    body = await req.json()
  } catch {
    return Response.json({ error: 'Invalid JSON' }, { status: 400 })
  }
  const { requestId } = (body ?? {}) as { requestId?: unknown }
  if (typeof requestId !== 'string') {
    return Response.json({ error: 'Bad request' }, { status: 400 })
  }
  const result = getLog().supplyDemoCredential(requestId)
  if (!result.ok) return Response.json({ error: result.error }, { status: 409 })
  return Response.json({ ok: true }, { headers: { 'Cache-Control': 'no-store' } })
}
