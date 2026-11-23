'use client'

import Link from 'next/link'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import type { components } from '@/lib/operator/api'
import { AccessError, changeWorkerAuth, readWorkerStatus } from '@/lib/operator/source'
import { cn } from '@/lib/utils'
import { useOperator } from './store'

type WorkerStatus = components['schemas']['WorkerStatus']

const modes = {
  acknowledge: 'Acknowledgment',
  codex: 'Codex',
  simulated: 'Simulated',
}

const authLabels = {
  checking: 'Checking sign-in…',
  ready: 'Ready',
  required: 'Sign-in required',
  starting: 'Requesting a code…',
  waiting: 'Waiting for ChatGPT sign-in',
  disconnecting: 'Disconnecting…',
  unavailable: 'Sign-in status unavailable',
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
  const [acting, setActing] = useState(false)
  const [error, setError] = useState('')
  const actionVersion = useRef(0)
  const disconnectDialog = useRef<HTMLDialogElement>(null)

  useEffect(() => {
    if (mode !== 'live') return
    const abort = new AbortController()
    let timer: ReturnType<typeof setTimeout>

    async function refresh() {
      const version = actionVersion.current
      try {
        const current = await readWorkerStatus(AbortSignal.any([abort.signal, AbortSignal.timeout(5000)]))
        if (abort.signal.aborted) return
        if (version === actionVersion.current) {
          setStatus(current)
          setUnavailable(false)
        }
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
  const auth = online ? status?.auth : null
  const health = mode === 'demo' ? 'Demo has no live worker'
    : unavailable ? 'Worker status unavailable'
    : !status ? 'Checking worker status…'
    : online ? 'Online'
    : status.health === 'stale' ? 'Heartbeat stale'
    : 'No worker heartbeat yet'
  const task = online ? report?.active_task : null

  async function updateAuth(action: 'connect' | 'cancel' | 'disconnect') {
    actionVersion.current += 1
    setActing(true)
    setError('')
    try {
      const updated = await changeWorkerAuth(action)
      actionVersion.current += 1
      setStatus((current) => current && { ...current, auth: updated })
    } catch (cause) {
      setError(cause instanceof AccessError ? cause.message : 'Could not reach the worker.')
    } finally {
      setActing(false)
    }
  }

  return (
    <section className="flex flex-col gap-4 rounded-xl border border-border bg-card p-4" aria-label="Worker status">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-lg font-semibold">Worker</h2>
        <p role="status" className={cn('flex items-center gap-2 rounded-full bg-secondary px-2.5 py-1 text-xs font-medium', online ? 'text-verified' : 'text-muted-foreground')}>
          <span aria-hidden="true" className={cn('size-2 rounded-full bg-current', status?.health === 'stale' && !unavailable && 'text-attention')} />
          {health}
        </p>
      </div>
      {auth && (
        <div className="flex flex-col gap-3 rounded-lg border border-border p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h3 className="text-sm font-medium">Codex connection</h3>
              <p role="status" className={cn('mt-0.5 text-sm', auth.state === 'ready' ? 'text-verified' : 'text-muted-foreground')}>
                {authLabels[auth.state]}
              </p>
            </div>
            {(auth.state === 'required' || auth.state === 'unavailable') && (
              <Button onClick={() => void updateAuth('connect')} disabled={acting}>
                {auth.reconnect ? 'Reconnect' : 'Connect'}
              </Button>
            )}
            {(auth.state === 'starting' || auth.state === 'waiting') && (
              <Button variant="outline" onClick={() => void updateAuth('cancel')} disabled={acting}>Cancel sign-in</Button>
            )}
            {auth.state === 'ready' && auth.can_disconnect && (
              <>
                <Button variant="outline" onClick={() => disconnectDialog.current?.showModal()} disabled={acting}>Disconnect</Button>
                <dialog
                  ref={disconnectDialog}
                  aria-labelledby="disconnect-worker-title"
                  className="m-auto w-[calc(100%-2rem)] max-w-sm rounded-xl border border-border bg-card p-5 text-card-foreground backdrop:bg-black/50"
                >
                  <form method="dialog" className="flex flex-col gap-4">
                    <h4 id="disconnect-worker-title" className="font-semibold">Disconnect this worker?</h4>
                    <p className="text-sm text-muted-foreground">The current task can finish. The worker will sign out of ChatGPT and hold new model tasks until you reconnect.</p>
                    <div className="flex justify-end gap-2">
                      <Button type="submit" variant="outline" autoFocus>Cancel</Button>
                      <Button type="button" variant="destructive" onClick={() => {
                        disconnectDialog.current?.close()
                        void updateAuth('disconnect')
                      }}>Disconnect</Button>
                    </div>
                  </form>
                </dialog>
              </>
            )}
          </div>
          {auth.login ? (
            <div className="flex flex-col items-start gap-2">
              <p className="text-sm">Open the verification page and enter this one-time code.</p>
              <code className="select-all rounded-md bg-secondary px-3 py-2 font-mono text-base font-semibold">{auth.login.user_code}</code>
              <a
                className="text-sm font-medium text-primary underline underline-offset-4"
                href={auth.login.verification_url}
                target="_blank"
                rel="noreferrer"
              >
                Open ChatGPT verification
              </a>
            </div>
          ) : auth.state === 'required' ? (
            <p className="text-sm text-muted-foreground">
              Model tasks wait for sign-in. Device code login must be enabled in ChatGPT settings or by your workspace admin.
            </p>
          ) : null}
          {(error || auth.message) && <p role="alert" className="text-sm text-attention">{error || auth.message}</p>}
        </div>
      )}
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
              <WorkerField label="Linux account">{report.user ? <code>{report.user}</code> : 'Unavailable'}</WorkerField>
              <WorkerField label="Effective UID / GID"><code>{report.uid} / {report.gid}</code></WorkerField>
              <WorkerField label="PID"><code>{report.pid}</code></WorkerField>
              <WorkerField label="Started">
                <time dateTime={report.started_at}>{new Date(report.started_at).toLocaleString()}</time>
              </WorkerField>
              <WorkerField label="Worker revision">
                {report.revision ? <code title={report.revision}>{report.revision.slice(0, 7)}</code> : 'Unavailable'}
              </WorkerField>
            </>
          )}
        </dl>
      )}
    </section>
  )
}
