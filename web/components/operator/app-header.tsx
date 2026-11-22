'use client'

import Link from 'next/link'
import { useEffect, useRef, useState } from 'react'
import { usePathname } from 'next/navigation'
import { ArrowLeft, Check, MoreHorizontal, RotateCcw, ScanSearch, Unplug, X } from 'lucide-react'
import { useOperator, type Connection } from './store'
import { replay, taskOutcome, incidentOutcome } from '@/lib/operator/project'
import { clock } from '@/lib/operator/format'
import { cn } from '@/lib/utils'

const connLabel: Record<Connection, string> = {
  connecting: 'Connecting',
  live: 'Live',
  reconnecting: 'Reconnecting',
  offline: 'Offline',
}

export function AppHeader({ back }: { back?: { href: string; label: string } }) {
  const { connection, state, consistent, simulateDisconnect, resetScenario } = useOperator()
  const [open, setOpen] = useState(false)
  const inspecting = usePathname().startsWith('/inspect')
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (e: PointerEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false)
    document.addEventListener('pointerdown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  return (
    <header className="sticky top-0 z-30 border-b border-border bg-background/90 pt-[env(safe-area-inset-top)] backdrop-blur">
      <div className="mx-auto flex h-14 max-w-6xl items-center gap-3 px-4">
        {back ? (
          <Link
            href={back.href}
            className="-ml-2 flex size-11 items-center justify-center rounded-full text-muted-foreground hover:bg-secondary hover:text-foreground"
          >
            <ArrowLeft className="size-5" aria-hidden="true" />
            <span className="sr-only">{back.label}</span>
          </Link>
        ) : null}
        <Link href="/" className="flex min-w-0 flex-col leading-tight">
          <span className="text-sm font-semibold">Operator</span>
          <span className="truncate font-mono text-xs text-muted-foreground">vps-fra-1 · kj.dev</span>
        </Link>
        <div className="ml-auto flex items-center gap-1">
          <Link
            href="/inspect"
            aria-current={inspecting ? 'page' : undefined}
            className={cn(
              'flex h-11 items-center gap-1.5 rounded-full px-3 text-sm',
              inspecting ? 'bg-secondary font-medium text-foreground' : 'text-muted-foreground hover:bg-secondary hover:text-foreground',
            )}
          >
            <ScanSearch className="size-4" aria-hidden="true" />
            Inspect
          </Link>
          <span
            className="flex h-8 items-center rounded-full border border-attention/60 px-2.5 font-mono text-xs font-medium text-attention"
            title="Public demo with a simulated operator. No real VPS or credentials."
          >
            Demo
          </span>
          <span
            className={cn(
              'flex h-8 items-center gap-2 rounded-full px-3 font-mono text-xs',
              connection === 'live' ? 'bg-secondary text-foreground' : 'bg-attention/15 text-attention',
            )}
            role="status"
            aria-live="polite"
          >
            <span
              className={cn(
                'size-2 rounded-full',
                connection === 'live' ? 'bg-verified' : 'bg-attention',
                connection !== 'offline' && connection !== 'live' && 'animate-pulse',
              )}
              aria-hidden="true"
            />
            <span className={cn(connection === 'live' && 'sr-only sm:not-sr-only')}>{connLabel[connection]}</span>
            <span className="text-muted-foreground">#{state.lastSeq}</span>
          </span>
          <div className="relative" ref={menuRef}>
            <button
              type="button"
              onClick={() => setOpen((o) => !o)}
              aria-expanded={open}
              aria-haspopup="menu"
              className="flex size-11 items-center justify-center rounded-full text-muted-foreground hover:bg-secondary hover:text-foreground"
            >
              <MoreHorizontal className="size-5" aria-hidden="true" />
              <span className="sr-only">Session menu</span>
            </button>
            {open ? (
              <div
                role="menu"
                className="absolute right-0 top-12 w-72 rounded-xl border border-border bg-popover p-2 text-popover-foreground shadow-xl"
              >
                <div className="flex items-start gap-2 px-3 py-2 text-xs text-muted-foreground">
                  <Check className={cn('mt-0.5 size-3.5 shrink-0', consistent ? 'text-verified' : 'text-destructive')} aria-hidden="true" />
                  <span className="text-pretty">
                    {consistent
                      ? `Live view matches a full replay of ${state.lastSeq} events.`
                      : 'Live view and replay disagree. Reload to rebuild from history.'}
                  </span>
                </div>
                <button
                  role="menuitem"
                  type="button"
                  disabled={connection !== 'live'}
                  onClick={() => {
                    setOpen(false)
                    simulateDisconnect()
                  }}
                  className="flex min-h-11 w-full items-center gap-3 rounded-lg px-3 text-left text-sm hover:bg-secondary disabled:opacity-50"
                >
                  <Unplug className="size-4" aria-hidden="true" />
                  Drop connection for 14 s
                </button>
                <button
                  role="menuitem"
                  type="button"
                  onClick={() => {
                    setOpen(false)
                    void resetScenario()
                  }}
                  className="flex min-h-11 w-full items-center gap-3 rounded-lg px-3 text-left text-sm hover:bg-secondary"
                >
                  <RotateCcw className="size-4" aria-hidden="true" />
                  Replay the overnight scenario
                </button>
                <p className="px-3 pb-1 pt-2 text-xs leading-relaxed text-muted-foreground">
                  Prototype: the operator is simulated from a modeled event log.
                </p>
              </div>
            ) : null}
          </div>
        </div>
      </div>
      <ConnectionBanner />
    </header>
  )
}

function ConnectionBanner() {
  const { connection, catchUp, dismissCatchUp, events } = useOperator()

  if (connection === 'offline' || connection === 'reconnecting') {
    return (
      <div className="border-t border-attention/30 bg-attention/10">
        <p className="mx-auto max-w-6xl px-4 py-2 text-sm text-attention">
          {connection === 'offline' ? 'Disconnected.' : 'Reconnecting.'} The operator keeps working. You are seeing
          everything up to #{events[events.length - 1]?.seq ?? 0}.
        </p>
      </div>
    )
  }
  if (!catchUp) return null

  const missed = events.filter((e) => e.seq > catchUp.fromSeq && e.seq <= catchUp.toSeq)
  const before = replay(events.filter((e) => e.seq <= catchUp.fromSeq))
  const after = replay(events.filter((e) => e.seq <= catchUp.toSeq))
  const changes: string[] = []
  for (const id of after.taskOrder) {
    const a = taskOutcome(after.tasks[id])
    const b = before.tasks[id] ? taskOutcome(before.tasks[id]).label : 'new'
    if (a.label !== b) changes.push(`${after.tasks[id].title}: ${b} → ${a.label}`)
  }
  for (const id of after.incidentOrder) {
    const a = incidentOutcome(after.incidents[id])
    const b = before.incidents[id] ? incidentOutcome(before.incidents[id]).label : 'new'
    if (a.label !== b) changes.push(`Incident: ${b} → ${a.label}`)
  }

  return (
    <div className="rise border-t border-verified/30 bg-verified/10">
      <div className="mx-auto flex max-w-6xl items-start gap-3 px-4 py-2.5">
        <div className="min-w-0 flex-1 text-sm">
          <p className="font-medium text-verified">
            Back online. Replayed {missed.length} {missed.length === 1 ? 'event' : 'events'} since {clock(catchUp.offlineAt)}.
          </p>
          {changes.length ? (
            <ul className="mt-1 flex flex-col gap-0.5 text-foreground">
              {changes.map((c) => (
                <li key={c} className="text-pretty">
                  {c}
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-0.5 text-muted-foreground">No outcome changed while you were away.</p>
          )}
        </div>
        <button
          type="button"
          onClick={dismissCatchUp}
          className="-mr-2 flex size-11 shrink-0 items-center justify-center rounded-full text-muted-foreground hover:bg-secondary"
        >
          <X className="size-4" aria-hidden="true" />
          <span className="sr-only">Dismiss</span>
        </button>
      </div>
    </div>
  )
}
