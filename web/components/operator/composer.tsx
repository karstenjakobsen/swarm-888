'use client'

import Link from 'next/link'
import { useState } from 'react'
import { ArrowUp } from 'lucide-react'
import { useOperator } from './store'

export function Composer({ taskId, placeholder }: { taskId?: string; placeholder?: string }) {
  const { send, state } = useOperator()
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [sentAtSeq, setSentAtSeq] = useState<number | null>(null)

  const recent =
    sentAtSeq === null
      ? []
      : state.messages.filter((m) => m.seq > sentAtSeq && (taskId ? m.task === taskId : true)).slice(-2)

  async function submit() {
    const value = text.trim()
    if (!value || busy) return
    setBusy(true)
    setError(null)
    const seq = state.lastSeq
    const res = await send({ kind: 'message', text: value, taskId })
    setBusy(false)
    if (res.ok) {
      setText('')
      setSentAtSeq(seq)
    } else setError(res.error ?? 'Could not send.')
  }

  return (
    <div className="sticky bottom-0 z-20 border-t border-border bg-background/95 pb-[env(safe-area-inset-bottom)] backdrop-blur">
      <div className="mx-auto flex max-w-6xl flex-col gap-2 px-4 py-3">
        {recent.length ? (
          <ul className="flex flex-col gap-1 text-sm" aria-live="polite">
            {recent.map((m) => (
              <li key={m.seq} className="flex gap-2">
                <span className="w-16 shrink-0 text-muted-foreground">{m.from === 'owner' ? 'You' : 'Operator'}</span>
                <span className="min-w-0 flex-1 text-pretty">{m.text}</span>
                {!taskId && m.task ? (
                  <Link href={`/work/${m.task}`} className="shrink-0 text-muted-foreground underline underline-offset-4">
                    Open
                  </Link>
                ) : null}
              </li>
            ))}
          </ul>
        ) : null}
        <form
          onSubmit={(e) => {
            e.preventDefault()
            void submit()
          }}
          className="flex items-end gap-2"
        >
          <label htmlFor="composer" className="sr-only">
            {taskId ? 'Steer this task' : 'Ask the operator or request a change'}
          </label>
          <textarea
            id="composer"
            rows={1}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                if (e.nativeEvent.isComposing || e.keyCode === 229) return
                e.preventDefault()
                void submit()
              }
            }}
            placeholder={placeholder ?? 'Ask, give work, or request a change'}
            className="max-h-32 min-h-11 flex-1 resize-none rounded-xl border border-input bg-card px-3.5 py-2.5 text-base leading-6 outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring"
          />
          <button
            type="submit"
            disabled={busy || !text.trim()}
            className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-primary text-primary-foreground disabled:opacity-40"
          >
            <ArrowUp className="size-5" aria-hidden="true" />
            <span className="sr-only">Send</span>
          </button>
        </form>
        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
      </div>
    </div>
  )
}
