import { getLog, resetLog } from '@/lib/operator/server-log'

export const dynamic = 'force-dynamic'

type Body =
  | { kind: 'message'; text: string; taskId?: string }
  | { kind: 'stop'; taskId: string }
  | { kind: 'decide'; requestId: string; optionId: string }
  | { kind: 'reset' }

const isStr = (v: unknown, max = 200): v is string => typeof v === 'string' && v.length > 0 && v.length <= max

export async function POST(req: Request) {
  let body: Body
  try {
    body = (await req.json()) as Body
  } catch {
    return Response.json({ error: 'Invalid JSON' }, { status: 400 })
  }
  const log = getLog()
  switch (body.kind) {
    case 'message': {
      const text = typeof body.text === 'string' ? body.text.trim() : ''
      if (!text || text.length > 2000) return Response.json({ error: 'Message is empty or too long' }, { status: 400 })
      if (body.taskId !== undefined && !isStr(body.taskId)) return Response.json({ error: 'Bad task' }, { status: 400 })
      log.message(text, body.taskId)
      return Response.json({ ok: true })
    }
    case 'stop':
      if (!isStr(body.taskId)) return Response.json({ error: 'Bad task' }, { status: 400 })
      return log.stop(body.taskId)
        ? Response.json({ ok: true })
        : Response.json({ error: 'Task is not running' }, { status: 409 })
    case 'decide':
      if (!isStr(body.requestId) || !isStr(body.optionId)) return Response.json({ error: 'Bad decision' }, { status: 400 })
      return log.decide(body.requestId, body.optionId)
        ? Response.json({ ok: true })
        : Response.json({ error: 'Decision already made or unknown' }, { status: 409 })
    case 'reset':
      resetLog().begin()
      return Response.json({ ok: true })
    default:
      return Response.json({ error: 'Unknown command' }, { status: 400 })
  }
}
