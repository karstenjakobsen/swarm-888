import { operatorMode } from '@/lib/operator/mode'
import { getLog } from '@/lib/operator/server-log'

export const dynamic = 'force-dynamic'

export async function GET(req: Request) {
  if (operatorMode() !== 'demo') return new Response(null, { status: 503 })
  const params = new URL(req.url).searchParams
  const after = Number(req.headers.get('last-event-id') ?? params.get('after') ?? '0')
  if (!Number.isSafeInteger(after) || after < 0) {
    return Response.json({ error: 'Invalid event cursor' }, { status: 400 })
  }
  const log = getLog()
  log.begin()
  const epoch = params.get('epoch')
  let cursor = after
  const encoder = new TextEncoder()
  let cancel: () => void
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const write = (s: string) => controller.enqueue(encoder.encode(s))
      const pump = () => {
        for (const e of log.readAfter(cursor)) {
          write(`id: ${e.seq}\nevent: op\ndata: ${JSON.stringify(e)}\n\n`)
          cursor = e.seq
        }
      }
      let ticks = 0
      const timer = setInterval(() => {
        if (getLog() !== log) {
          write('event: reset\ndata: {}\n\n')
          close()
          return
        }
        pump()
        if (++ticks % 30 === 0) write(': keepalive\n\n')
      }, 500)
      function close() {
        cancel()
        controller.close()
      }
      cancel = () => {
        clearInterval(timer)
        req.signal.removeEventListener('abort', close)
      }
      if (req.signal.aborted) return close()
      req.signal.addEventListener('abort', close, { once: true })
      if ((epoch !== null && epoch !== log.epoch) || cursor > log.cursor) {
        write('event: reset\ndata: {}\n\n')
        return close()
      }
      write(`retry: 1500\nevent: hello\ndata: ${JSON.stringify({ epoch: log.epoch, from: cursor })}\n\n`)
      pump()
      write(`event: caught-up\ndata: ${cursor}\n\n`)
    },
    cancel() { cancel() },
  })

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    },
  })
}
