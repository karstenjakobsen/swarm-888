'use client'

import { useEffect, useRef, useState } from 'react'
import { FlaskConical, KeyRound, Play, X } from 'lucide-react'
import type { Credential } from '@/lib/operator/project'
import { useOperator } from './store'

export function CredentialButton({ credential, taskTitle, className }: { credential: Credential; taskTitle: string; className?: string }) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={
          className ??
          'flex min-h-11 items-center justify-center gap-2 rounded-lg bg-attention px-4 text-sm font-medium text-attention-foreground hover:opacity-90'
        }
      >
        <KeyRound className="size-4" aria-hidden="true" />
        Review credential request
      </button>
      {open ? <CredentialDialog credential={credential} taskTitle={taskTitle} onClose={() => setOpen(false)} /> : null}
    </>
  )
}

function CredentialDialog({ credential, taskTitle, onClose }: { credential: Credential; taskTitle: string; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null)
  const { applyDemoCredential } = useOperator()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    ref.current?.showModal()
  }, [])

  async function resumeWithDemo() {
    setBusy(true)
    setError(null)
    const res = await applyDemoCredential(credential.requestId)
    setBusy(false)
    if (res.ok) onClose()
    else setError(res.error ?? 'Could not resume the task.')
  }

  return (
    <dialog
      ref={ref}
      onClose={onClose}
      aria-labelledby="cred-title"
      className="m-0 mt-auto w-full max-w-none rounded-t-2xl border border-border bg-card p-0 text-card-foreground sm:m-auto sm:max-w-md sm:rounded-2xl"
    >
      <div className="flex flex-col gap-5 p-5 pb-[calc(1.25rem+env(safe-area-inset-bottom))]">
        <div className="flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Credential request</p>
            <h2 id="cred-title" className="mt-1 text-lg font-semibold text-balance">
              {credential.label}
            </h2>
          </div>
          <button
            type="button"
            onClick={() => ref.current?.close()}
            className="-mr-2 -mt-1 flex size-11 items-center justify-center rounded-full text-muted-foreground hover:bg-secondary"
          >
            <X className="size-5" aria-hidden="true" />
            <span className="sr-only">Close</span>
          </button>
        </div>

        <dl className="grid grid-cols-[6.5rem_1fr] gap-x-3 gap-y-2.5 text-sm">
          <dt className="text-muted-foreground">For task</dt>
          <dd>{taskTitle}</dd>
          <dt className="text-muted-foreground">Why</dt>
          <dd className="text-pretty">{credential.why}</dd>
          <dt className="text-muted-foreground">Sent to</dt>
          <dd className="font-mono text-xs leading-relaxed">{credential.destination}</dd>
          <dt className="text-muted-foreground">Permissions</dt>
          <dd className="font-mono text-xs leading-relaxed">{credential.scope}</dd>
          <dt className="text-muted-foreground">Stored</dt>
          <dd className="text-pretty">{credential.storage}</dd>
        </dl>

        <div className="flex gap-3 rounded-xl border border-border bg-well p-4">
          <FlaskConical className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          <div className="flex flex-col gap-1">
            <p className="text-sm font-medium">This is a public demo</p>
            <p className="text-pretty text-sm leading-relaxed text-muted-foreground">
              It never asks for or accepts a real key. The demo vault stores a placeholder so the task can resume and show what
              happens next.
            </p>
          </div>
        </div>

        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}

        <button
          type="button"
          onClick={() => void resumeWithDemo()}
          disabled={busy}
          className="flex min-h-12 items-center justify-center gap-2 rounded-lg bg-attention px-4 text-base font-medium text-attention-foreground hover:opacity-90 disabled:opacity-60"
        >
          <Play className="size-4" aria-hidden="true" />
          {busy ? 'Resuming task' : 'Use demo credential and resume'}
        </button>
      </div>
    </dialog>
  )
}
