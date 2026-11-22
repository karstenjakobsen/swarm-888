import { getLog } from '@/lib/operator/server-log'

export const dynamic = 'force-dynamic'

export async function GET(req: Request) {
  const url = new URL(req.url)
  const raw = req.headers.get('last-event-id') ?? url.searchParams.get('after') ?? '0'
  const requestedEpoch = url.searchParams.get('epoch')
  const log = getLog()
  log.begin()
  let cursor = requestedEpoch === log.epoch ? Math.max(0, Number.parseInt(raw, 10) || 0) : 0
  const encoder = new TextEncoder()

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false
      const write = (s: string) => {
        if (!closed) controller.enqueue(encoder.encode(s))
      }
      write(`retry: 1500\nevent: hello\ndata: ${JSON.stringify({ epoch: log.epoch, from: cursor })}\n\n`)
      const pump = () => {
        for (const e of log.readAfter(cursor)) {
          write(`id: ${e.seq}\nevent: op\ndata: ${JSON.stringify(e)}\n\n`)
          cursor = e.seq
        }
      }
      pump()
      let ticks = 0
      const iv = setInterval(() => {
        try {
          pump()
          if (++ticks % 30 === 0) write(': keepalive\n\n')
        } catch {
          clearInterval(iv)
        }
      }, 500)
      req.signal.addEventListener('abort', () => {
        closed = true
        clearInterval(iv)
        try {
          controller.close()
        } catch {}
      })
    },
  })

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    },
  })
}
