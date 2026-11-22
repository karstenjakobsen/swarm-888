'use client'

import Link from 'next/link'
import { useEffect, useState, type ReactNode } from 'react'
import type { components } from '@/lib/operator/api'
import { readWorkerStatus } from '@/lib/operator/source'
import { cn } from '@/lib/utils'
import { useOperator } from './store'

type WorkerStatus = components['schemas']['WorkerStatus']

const modes = {
  acknowledge: 'Acknowledgment',
  codex: 'Codex',
  simulated: 'Simulated',
}

function WorkerField({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs font-medium text-muted-foreground">{label}</dt>
      <dd className="mt-1 break-words text-sm">{children}</dd>
    </div>
  )
}

export function WorkerTab() {
  const { mode, state } = useOperator()
  const [status, setStatus] = useState<WorkerStatus>()
  const [unavailable, setUnavailable] = useState(false)

  useEffect(() => {
    if (mode !== 'live') return
    const abort = new AbortController()
    let timer: ReturnType<typeof setTimeout>

    async function refresh() {
      try {
        const current = await readWorkerStatus(AbortSignal.any([abort.signal, AbortSignal.timeout(5000)]))
        if (abort.signal.aborted) return
        setStatus(current)
        setUnavailable(false)
      } catch {
        if (!abort.signal.aborted) setUnavailable(true)
      }
      if (!abort.signal.aborted) timer = setTimeout(refresh, 3000)
    }

    void refresh()
    return () => {
      abort.abort()
      clearTimeout(timer)
    }
  }, [mode])

  const report = status?.report
  const online = !unavailable && status?.health === 'online'
  const health = mode === 'demo' ? 'Demo has no live worker'
    : unavailable ? 'Worker status unavailable'
    : !status ? 'Checking worker status…'
    : online ? 'Online'
    : status.health === 'stale' ? 'Heartbeat stale'
    : 'No worker heartbeat yet'
  const task = online ? report?.active_task : null

  return (
    <section className="flex flex-col gap-4 rounded-xl border border-border bg-card p-4" aria-label="Worker status">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-lg font-semibold">Worker</h2>
        <p role="status" className={cn('flex items-center gap-2 rounded-full bg-secondary px-2.5 py-1 text-xs font-medium', online ? 'text-verified' : 'text-muted-foreground')}>
          <span aria-hidden="true" className={cn('size-2 rounded-full bg-current', status?.health === 'stale' && !unavailable && 'text-attention')} />
          {health}
        </p>
      </div>
      {status && (
        <dl className="grid grid-cols-2 gap-x-4 gap-y-4 border-t border-border pt-4 sm:grid-cols-3">
          <WorkerField label="Queued tasks">{unavailable ? 'Unavailable' : status.queued_tasks}</WorkerField>
          <WorkerField label="Current task">
            {task ? (
              <Link className="underline underline-offset-4" href={`/work/${encodeURIComponent(task)}`}>
                {state.tasks[task]?.title ?? task}
              </Link>
            ) : online ? 'Idle' : 'Unavailable'}
          </WorkerField>
          {report && (
            <>
              <WorkerField label="Last heartbeat">
                <time dateTime={report.last_heartbeat}>{new Date(report.last_heartbeat).toLocaleString()}</time>
              </WorkerField>
              <WorkerField label="Host">{report.host}</WorkerField>
              <WorkerField label="Model mode">{modes[report.mode]}</WorkerField>
              <WorkerField label="Effective UID / GID"><code>{report.uid} / {report.gid}</code></WorkerField>
              <WorkerField label="PID"><code>{report.pid}</code></WorkerField>
              <WorkerField label="Started">
                <time dateTime={report.started_at}>{new Date(report.started_at).toLocaleString()}</time>
              </WorkerField>
              <WorkerField label="Framework revision">
                {report.revision ? <code className="break-all">{report.revision}</code> : 'Unavailable'}
              </WorkerField>
            </>
          )}
        </dl>
      )}
    </section>
  )
}
