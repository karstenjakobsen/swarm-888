'use client'

import Link from 'next/link'
import { useEffect, useState } from 'react'
import { KeyRound, Lock } from 'lucide-react'
import type { components } from '@/lib/operator/api'
import { readCatalogStatus } from '@/lib/operator/source'
import { useOperator } from './store'
import { AppHeader } from './app-header'
import { connectorSource, Meta, SourceLink } from './inspect-parts'
import { recordById, type Connector, type Projection } from '@/lib/operator/project'
import { dayClock } from '@/lib/operator/format'
import { cn } from '@/lib/utils'

export function ConnectorView({ id }: { id: string }) {
  const { state, loaded, mode } = useOperator()
  const connector = recordById(state.connectors, id)
  const [items, setItems] = useState<components['schemas']['CatalogItemInfo'][]>()
  const item = items?.find((item) => item.canonical_id === id)

  useEffect(() => {
    if (mode !== 'live') return
    const abort = new AbortController()
    void readCatalogStatus(AbortSignal.any([abort.signal, AbortSignal.timeout(5000)])).then(
      (status) => {
        if (!abort.signal.aborted) {
          setItems(status.connections?.find((connection) => connection.kind === 'connector')?.items ?? [])
        }
      },
      () => {
        if (!abort.signal.aborted) setItems([])
      },
    )
    return () => abort.abort()
  }, [mode])

  return (
    <div className="flex min-h-dvh flex-col">
      <AppHeader back={{ href: '/inspect?tab=connectors', label: 'Back to connectors' }} />
      <main className="mx-auto w-full max-w-3xl flex-1 px-4 pb-12 pt-5">
        {!loaded || (!connector && mode === 'live' && !items) ? (
          <div className="h-40 animate-pulse rounded-xl bg-card" aria-busy="true" />
        ) : connector ? (
          <Detail c={connector} state={state} instructions={item?.instructions} />
        ) : item ? (
          <article className="flex flex-col gap-7">
            <h1 className="text-2xl font-semibold">{item.name}</h1>
            {item.instructions && <Instructions text={item.instructions} />}
          </article>
        ) : (
          <p className="text-muted-foreground">No connector with this id.</p>
        )}
      </main>
    </div>
  )
}

function TaskLink({ state, id }: { state: Projection; id: string }) {
  const t = state.tasks[id]
  return (
    <Link href={`/work/${id}`} className="underline underline-offset-4">
      {t?.title ?? id}
    </Link>
  )
}

function Instructions({ text }: { text: string }) {
  return (
    <section className="flex flex-col gap-2">
      <h2 className="text-sm font-medium">How to use</h2>
      <p className="whitespace-pre-wrap text-sm leading-relaxed">{text}</p>
    </section>
  )
}

function Detail({ c, state, instructions }: { c: Connector; state: Projection; instructions?: string | null }) {
  const uses = [...c.uses].reverse()
  const lastChange = uses.find((u) => u.record)
  const stored = c.credential.status === 'stored'
  const waitingTask = c.credential.request ? state.credentials[c.credential.request]?.task : undefined

  return (
    <article className="flex flex-col gap-7">
      <div className="flex flex-col gap-2">
        <p className="font-mono text-xs text-muted-foreground">Connector · configured {dayClock(c.configuredAt)}</p>
        <h1 className="text-2xl font-semibold leading-tight">{c.name}</h1>
        <p className="text-sm text-muted-foreground">{c.provider}</p>
      </div>

      {instructions && <Instructions text={instructions} />}

      {c.manages ? (
        <section className="flex flex-col gap-3 rounded-xl border border-border bg-card p-4">
          <h2 className="text-xs font-medium text-muted-foreground">Configured to manage</h2>
          <p className="flex items-baseline gap-2">
            <span className="text-sm text-muted-foreground">{c.manages.label}</span>
            <span className="font-mono text-lg">{c.manages.value}</span>
          </p>
          {lastChange?.record ? (
            <div className="flex flex-col gap-1.5 border-t border-border pt-3">
              <p className="text-xs text-muted-foreground">Last record change</p>
              <p className="break-words font-mono text-sm">
                {lastChange.record.change} {lastChange.record.name}.{lastChange.record.zone} {lastChange.record.type}{' '}
                {lastChange.record.value} <span className="text-muted-foreground">ttl {lastChange.record.ttl}</span>
              </p>
              <p className="text-pretty text-sm">
                <span className="text-muted-foreground">by </span>
                <TaskLink state={state} id={lastChange.task} />
                <span className="text-muted-foreground">
                  {' '}
                  · {dayClock(lastChange.at)} · #{lastChange.seq}
                </span>
              </p>
            </div>
          ) : null}
        </section>
      ) : null}

      <section className="flex flex-col gap-2">
        <h2 className="text-xs font-medium text-muted-foreground">Access scope</h2>
        <p className="text-pretty text-sm leading-relaxed">{c.scope}</p>
      </section>

      {c.catalog ? <SourceLink catalog={c.catalog} body={connectorSource(c)} /> : null}

      <section className="flex flex-col gap-2">
        <h2 className="text-xs font-medium text-muted-foreground">Credential</h2>
        <div className="flex flex-col gap-3 rounded-xl border border-border bg-card p-4">
          <span
            className={cn(
              'flex items-center gap-1.5 self-start rounded-full px-2.5 py-1 text-xs font-medium',
              stored ? 'bg-verified/15 text-verified' : 'bg-attention/15 text-attention',
            )}
          >
            <KeyRound className="size-3.5" aria-hidden="true" />
            {stored ? 'Stored' : 'Awaiting credential'}
          </span>
          <Meta
            rows={[
              ['Name', c.credential.label],
              ['Fingerprint', c.credential.fingerprint ? <span className="font-mono text-xs">{c.credential.fingerprint}</span> : '—'],
              ['Stored in', c.credential.storage],
            ]}
          />
          <p className="flex gap-2 text-pretty text-xs leading-relaxed text-muted-foreground">
            <Lock className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
            The secret value stays in the vault. This app only receives the fingerprint, which changes if the credential changes.
          </p>
          {!stored && waitingTask ? (
            <Link href={`/work/${waitingTask}`} className="flex min-h-11 items-center justify-center rounded-lg bg-attention px-4 text-sm font-medium text-attention-foreground">
              Open the task that needs it
            </Link>
          ) : null}
        </div>
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="text-xs font-medium text-muted-foreground">Tools it exposes</h2>
        <ul className="flex flex-col divide-y divide-border overflow-hidden rounded-xl border border-border bg-card">
          {c.tools.map((t) => (
            <li key={t.name} className="flex items-start gap-3 px-4 py-3">
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="break-all font-mono text-sm">{t.name}</span>
                <span className="text-pretty text-xs leading-relaxed text-muted-foreground">{t.description}</span>
              </span>
              <span
                className={cn(
                  'shrink-0 rounded px-1.5 py-0.5 font-mono text-xs',
                  t.access === 'write' ? 'bg-attention/15 text-attention' : 'bg-secondary text-muted-foreground',
                )}
              >
                {t.access}
              </span>
            </li>
          ))}
        </ul>
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="text-xs font-medium text-muted-foreground">Successful uses</h2>
        {uses.length ? (
          <ul className="flex flex-col divide-y divide-border overflow-hidden rounded-xl border border-border bg-card">
            {uses.map((u) => (
              <li key={u.seq}>
                <Link href={`/work/${u.task}#e-${u.seq}`} className="flex flex-col gap-1 px-4 py-3 hover:bg-secondary/60">
                  <span className="text-pretty text-sm">{u.summary}</span>
                  <span className="text-pretty text-xs text-muted-foreground">{state.tasks[u.task]?.title ?? u.task}</span>
                  <span className="font-mono text-xs text-muted-foreground">
                    {u.tool} · {dayClock(u.at)} · #{u.seq}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        ) : (
          <p className="rounded-xl bg-card p-4 text-sm text-muted-foreground">Not used yet.</p>
        )}
      </section>
    </article>
  )
}
