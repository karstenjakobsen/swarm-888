'use client'

import Link from 'next/link'
import { useState } from 'react'
import { MessageSquareText } from 'lucide-react'
import { useOperator } from './store'
import { AppHeader } from './app-header'
import { memoryKind, sourceOf } from './inspect-parts'
import { recordById, type Memory, type Projection } from '@/lib/operator/project'
import { dayClock } from '@/lib/operator/format'
import { cn } from '@/lib/utils'

export function MemoryView({ id }: { id: string }) {
  const { state, loaded } = useOperator()
  const memory = recordById(state.memories, id)
  return (
    <div className="flex min-h-dvh flex-col">
      <AppHeader back={{ href: '/inspect', label: 'Back to memory' }} />
      <main className="mx-auto w-full max-w-3xl flex-1 px-4 pb-12 pt-5">
        {!loaded ? (
          <div className="h-40 animate-pulse rounded-xl bg-card" aria-busy="true" />
        ) : memory ? (
          <Entry memory={memory} state={state} />
        ) : (
          <p className="text-muted-foreground">No memory entry with this id.</p>
        )}
      </main>
    </div>
  )
}

function CorrectionRequest({ memory }: { memory: Memory }) {
  const { send } = useOperator()
  const [open, setOpen] = useState(false)
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [sent, setSent] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit() {
    const value = text.trim()
    if (!value || busy) return
    setBusy(true)
    setError(null)
    const res = await send({ kind: 'message', text: `Correct memory "${memory.title}" (${memory.id}): ${value}` })
    setBusy(false)
    if (res.ok) {
      setSent(true)
      setText('')
      setOpen(false)
    } else setError(res.error ?? 'Could not send.')
  }

  if (sent) {
    return (
      <p role="status" className="rounded-xl bg-card p-4 text-sm text-pretty text-muted-foreground">
        Sent to the operator. It will reply on the brief, and any change shows up here as a new version.
      </p>
    )
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex min-h-11 items-center justify-center gap-2 self-start rounded-lg border border-border px-4 text-sm font-medium hover:bg-secondary"
      >
        <MessageSquareText className="size-4" aria-hidden="true" />
        Ask the operator to correct this
      </button>
    )
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        void submit()
      }}
      className="flex flex-col gap-3 rounded-xl border border-border bg-card p-4"
    >
      <label htmlFor="correction" className="text-sm font-medium">
        What is wrong or out of date?
      </label>
      <textarea
        id="correction"
        rows={3}
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="For example: staging also runs nginx on :8443"
        className="min-h-24 resize-none rounded-lg border border-input bg-background px-3 py-2.5 text-base leading-6 outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring"
      />
      <p className="text-pretty text-xs leading-relaxed text-muted-foreground">
        This goes to the operator as a message. It decides how to update the entry and keeps the earlier text.
      </p>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      <div className="flex gap-2">
        <button
          type="submit"
          disabled={busy || !text.trim()}
          className="flex min-h-11 flex-1 items-center justify-center rounded-lg bg-primary px-4 text-sm font-medium text-primary-foreground disabled:opacity-40"
        >
          {busy ? 'Sending' : 'Send to operator'}
        </button>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="flex min-h-11 items-center justify-center rounded-lg px-4 text-sm text-muted-foreground hover:bg-secondary"
        >
          Cancel
        </button>
      </div>
    </form>
  )
}

function Entry({ memory, state }: { memory: Memory; state: Projection }) {
  const versions = [...memory.versions].reverse()
  return (
    <article className="flex flex-col gap-7">
      <div className="flex flex-col gap-2">
        <p className="font-mono text-xs text-muted-foreground">
          Memory · {memoryKind[memory.kind]} · {memory.id}
        </p>
        <h1 className="text-balance text-2xl font-semibold leading-tight">{memory.title}</h1>
      </div>

      <section className="flex flex-col gap-2">
        <h2 className="text-xs font-medium text-muted-foreground">
          {memory.versions.length > 1 ? `Text, ${memory.versions.length} versions` : 'Text'}
        </h2>
        <ol className="flex flex-col gap-3">
          {versions.map((v, i) => {
            const src = sourceOf(state, v.source)
            return (
              <li
                key={v.seq}
                id={`e-${v.seq}`}
                className={cn('flex flex-col gap-3 rounded-xl border p-4', i === 0 ? 'border-border bg-card' : 'border-dashed border-border')}
              >
                <p className={cn('whitespace-pre-wrap text-pretty text-sm leading-relaxed', i > 0 && 'text-muted-foreground line-through decoration-muted-foreground/40')}>
                  {v.text}
                </p>
                <p className="flex flex-wrap gap-x-2 font-mono text-xs text-muted-foreground">
                  <span>{i === 0 ? (versions.length > 1 ? 'Current · updated' : 'Written') : 'Earlier version'}</span>
                  <span>{dayClock(v.at)}</span>
                  <span>event #{v.seq}</span>
                </p>
                {src ? (
                  <p className="text-sm">
                    <span className="text-muted-foreground">From </span>
                    <Link href={src.href} className="underline underline-offset-4">
                      {src.label}
                    </Link>
                  </p>
                ) : null}
              </li>
            )
          })}
        </ol>
      </section>

      <CorrectionRequest memory={memory} />

      <section className="flex flex-col gap-2">
        <h2 className="text-xs font-medium text-muted-foreground">Read by later tasks</h2>
        {memory.readBy.length ? (
          <ul className="flex flex-col divide-y divide-border overflow-hidden rounded-xl border border-border bg-card">
            {[...memory.readBy].reverse().map((r) => {
              const t = state.tasks[r.task]
              return (
                <li key={r.seq}>
                  <Link href={`/work/${r.task}`} className="flex flex-col gap-1 px-4 py-3 hover:bg-secondary/60">
                    <span className="text-pretty text-sm font-medium">{t?.title ?? r.task}</span>
                    <span className="text-pretty text-xs leading-relaxed text-muted-foreground">{r.why}</span>
                    <span className="font-mono text-xs text-muted-foreground">
                      {dayClock(r.at)} · #{r.seq}
                    </span>
                  </Link>
                </li>
              )
            })}
          </ul>
        ) : (
          <p className="rounded-xl bg-card p-4 text-sm text-muted-foreground">No task has read this entry since it was written.</p>
        )}
      </section>
    </article>
  )
}
