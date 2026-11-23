'use client'

import Link from 'next/link'
import { useDeferredValue, useState } from 'react'
import { KeyRound, Search } from 'lucide-react'
import { useOperator } from './store'
import { AppHeader } from './app-header'
import { WorkerTab } from './worker-tab'
import { CatalogTab } from './catalog-tab'
import { current, lastUse, memoryKind, Rev, sourceOf } from './inspect-parts'
import type { Projection } from '@/lib/operator/project'
import { dayClock } from '@/lib/operator/format'
import { cn } from '@/lib/utils'

export type InspectTab = 'memory' | 'skills' | 'connectors' | 'projects' | 'worker' | 'catalog'

const tabs: { id: InspectTab; label: string; count?: (s: Projection) => number }[] = [
  { id: 'memory', label: 'Memory', count: (s) => s.memoryOrder.length },
  { id: 'skills', label: 'Skills', count: (s) => s.skillOrder.length },
  { id: 'connectors', label: 'Connectors', count: (s) => s.connectorOrder.length },
  { id: 'projects', label: 'Projects', count: (s) => s.projectOrder.length },
  { id: 'worker', label: 'Workers' },
  { id: 'catalog', label: 'Catalog' },
]

export function InspectView({ tab }: { tab: InspectTab }) {
  const { state, loaded, catalog } = useOperator()
  return (
    <div className="flex min-h-dvh flex-col">
      <AppHeader back={{ href: '/', label: 'Back to brief' }} />
      <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-4 px-4 pb-12 pt-5">
        <div className="flex flex-col gap-1">
          <h1 className="text-2xl font-semibold">Inspect</h1>
          <p className="text-pretty text-sm leading-relaxed text-muted-foreground">
            Details about the operator, its worker, and its catalog.
          </p>
        </div>
        {catalog && tab !== 'catalog' ? (
          <section aria-label="Catalog repository" className="rounded-xl bg-card p-4">
            <h2 className="text-xs font-medium text-muted-foreground">Catalog repository</h2>
            <p className="mt-1 break-all font-mono text-sm">{catalog.remote}</p>
            <p className="font-mono text-xs text-muted-foreground">{catalog.branch}</p>
          </section>
        ) : null}
        <nav aria-label="Inspect sections" className="flex gap-1 overflow-x-auto rounded-xl bg-card p-1">
          {tabs.map((t) => (
            <Link
              key={t.id}
              href={t.id === 'memory' ? '/inspect' : `/inspect?tab=${t.id}`}
              aria-current={tab === t.id ? 'page' : undefined}
              replace
              scroll={false}
              className={cn(
                'flex min-h-12 min-w-fit flex-1 flex-col items-center justify-center rounded-lg px-1 text-[13px] leading-tight',
                tab === t.id ? 'bg-secondary font-medium text-foreground' : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {t.label}
              {loaded && t.count ? <span className="font-mono text-[11px] text-muted-foreground">{t.count(state)}</span> : null}
            </Link>
          ))}
        </nav>
        {!loaded ? (
          <div className="h-40 animate-pulse rounded-xl bg-card" aria-busy="true" />
        ) : tab === 'memory' ? (
          <MemoryTab state={state} />
        ) : tab === 'skills' ? (
          <SkillsTab state={state} />
        ) : tab === 'connectors' ? (
          <ConnectorsTab state={state} />
        ) : tab === 'worker' ? (
          <WorkerTab />
        ) : tab === 'catalog' ? (
          <CatalogTab />
        ) : (
          <ProjectsTab state={state} />
        )}
      </main>
    </div>
  )
}

function MemoryTab({ state }: { state: Projection }) {
  const [query, setQuery] = useState('')
  const q = useDeferredValue(query).trim().toLowerCase()
  const entries = [...state.memoryOrder]
    .map((id) => state.memories[id])
    .sort((a, b) => current(b).seq - current(a).seq)
    .filter((m) => !q || `${m.title}\n${current(m).text}\n${m.id}`.toLowerCase().includes(q))

  return (
    <section className="flex flex-col gap-3" aria-label="Memory">
      <label className="relative block">
        <span className="sr-only">Search memory</span>
        <Search className="pointer-events-none absolute left-3.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search memory text"
          className="h-12 w-full rounded-xl border border-input bg-card pl-10 pr-3 text-base outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring"
        />
      </label>
      <p className="text-xs text-muted-foreground" aria-live="polite">
        {q ? `${entries.length} of ${state.memoryOrder.length} entries match` : `${entries.length} entries, newest first`}
      </p>
      <ul className="flex flex-col gap-3">
        {entries.map((m) => {
          const v = current(m)
          const src = sourceOf(state, v.source)
          const readers = new Set(m.readBy.map((r) => r.task)).size
          return (
            <li key={m.id}>
              <Link
                href={`/inspect/memory/${m.id}`}
                className="flex flex-col gap-2.5 rounded-xl border border-border bg-card p-4 hover:bg-secondary/40"
              >
                <span className="flex items-start justify-between gap-3">
                  <span className="text-pretty font-medium leading-snug">{m.title}</span>
                  <span className="shrink-0 rounded-full bg-secondary px-2 py-0.5 text-xs text-muted-foreground">{memoryKind[m.kind]}</span>
                </span>
                <span className="text-pretty text-sm leading-relaxed text-muted-foreground">{v.text}</span>
                <span className="flex flex-wrap gap-x-3 gap-y-1 font-mono text-xs text-muted-foreground">
                  <span>
                    {m.versions.length > 1 ? 'updated' : 'written'} {dayClock(v.at)} · #{v.seq}
                  </span>
                  <span>{readers ? `read by ${readers} later task${readers > 1 ? 's' : ''}` : 'not read yet'}</span>
                </span>
                {src ? <span className="truncate text-xs text-muted-foreground">From: {src.label}</span> : null}
              </Link>
            </li>
          )
        })}
      </ul>
      {entries.length === 0 ? (
        <p className="rounded-xl bg-card p-4 text-sm text-muted-foreground">No memory entry contains “{query.trim()}”.</p>
      ) : null}
    </section>
  )
}

function SkillsTab({ state }: { state: Projection }) {
  const skills = state.skillOrder.map((id) => state.skills[id]).sort((a, b) => Number(b.foundational) - Number(a.foundational))
  return (
    <ul className="flex flex-col gap-3" aria-label="Installed skills">
      {skills.map((s) => {
        const u = lastUse(s)
        const t = u ? sourceOf(state, u) : undefined
        return (
          <li key={s.id}>
            <Link href={`/skills/${s.id}`} className="flex flex-col gap-2.5 rounded-xl border border-border bg-card p-4 hover:bg-secondary/40">
              <span className="flex flex-wrap items-center gap-2">
                <span className="break-all font-mono text-sm font-medium">{s.name}</span>
                <span
                  className={cn(
                    'rounded-full px-2 py-0.5 text-xs',
                    s.foundational ? 'bg-primary/15 text-primary' : 'bg-secondary text-muted-foreground',
                  )}
                >
                  {s.foundational ? 'Foundational' : s.origin === 'learned' ? 'Learned on this VPS' : 'Installed'}
                </span>
              </span>
              <span className="text-pretty text-sm leading-relaxed text-muted-foreground">{s.purpose}</span>
              <span className="grid grid-cols-[5.5rem_1fr] gap-x-3 gap-y-1 text-xs">
                <span className="text-muted-foreground">Active rev</span>
                <span>
                  <Rev>{s.revision}</Rev>
                  {s.revisions.length > 1 ? <span className="ml-2 text-muted-foreground">{s.revisions.length} revisions</span> : null}
                </span>
                <span className="text-muted-foreground">Last used</span>
                <span className="min-w-0 text-pretty">
                  {u ? (
                    <>
                      {dayClock(u.at)}
                      {t ? <span className="text-muted-foreground"> · {t.label}</span> : null}
                    </>
                  ) : (
                    <span className="text-muted-foreground">Not used yet</span>
                  )}
                </span>
              </span>
            </Link>
          </li>
        )
      })}
    </ul>
  )
}

function ProjectsTab({ state }: { state: Projection }) {
  return (
    <ul className="flex flex-col gap-3" aria-label="Projects">
      {state.projectOrder.map((id) => {
        const p = state.projects[id]
        return (
          <li key={id}>
            <Link href={`/inspect/projects/${id}`} className="flex flex-col gap-2.5 rounded-xl border border-border bg-card p-4 hover:bg-secondary/40">
              <span className="flex flex-col">
                <span className="font-medium">{p.name}</span>
                <span className="text-pretty text-xs leading-relaxed text-muted-foreground">{p.description}</span>
              </span>
              <span className="grid grid-cols-[5.5rem_1fr] gap-x-3 gap-y-1 text-xs">
                <span className="text-muted-foreground">Hostname</span>
                <span className="font-mono">{p.hostname}</span>
                <span className="text-muted-foreground">App repo</span>
                <span className="break-all font-mono">{p.repo}</span>
                <span className="text-muted-foreground">Tasks</span>
                <span>{p.relatedTasks.length}</span>
              </span>
            </Link>
          </li>
        )
      })}
      {state.projectOrder.length === 0 ? <li className="rounded-xl bg-card p-4 text-sm text-muted-foreground">No projects registered.</li> : null}
    </ul>
  )
}

function ConnectorsTab({ state }: { state: Projection }) {
  return (
    <ul className="flex flex-col gap-3" aria-label="Configured connectors">
      {state.connectorOrder.map((id) => {
        const c = state.connectors[id]
        const u = c.uses[c.uses.length - 1]
        const stored = c.credential.status === 'stored'
        return (
          <li key={id}>
            <Link href={`/inspect/connectors/${id}`} className="flex flex-col gap-2.5 rounded-xl border border-border bg-card p-4 hover:bg-secondary/40">
              <span className="flex items-start justify-between gap-3">
                <span className="flex min-w-0 flex-col">
                  <span className="font-medium">{c.name}</span>
                  <span className="text-xs text-muted-foreground">{c.provider}</span>
                </span>
                <span
                  className={cn(
                    'flex shrink-0 items-center gap-1.5 rounded-full px-2 py-0.5 text-xs',
                    stored ? 'bg-verified/15 text-verified' : 'bg-attention/15 text-attention',
                  )}
                >
                  <KeyRound className="size-3" aria-hidden="true" />
                  {stored ? 'Credential stored' : 'Awaiting credential'}
                </span>
              </span>
              <span className="grid grid-cols-[5.5rem_1fr] gap-x-3 gap-y-1 text-xs">
                {c.manages ? (
                  <>
                    <span className="text-muted-foreground">{c.manages.label}</span>
                    <span className="font-mono">{c.manages.value}</span>
                  </>
                ) : null}
                <span className="text-muted-foreground">Tools</span>
                <span>
                  {c.tools.length} ({c.tools.filter((t) => t.access === 'write').length} can write)
                </span>
                <span className="text-muted-foreground">Last used</span>
                <span className="min-w-0 text-pretty">
                  {u ? (
                    <>
                      {dayClock(u.at)} <span className="text-muted-foreground">· {u.summary}</span>
                    </>
                  ) : (
                    <span className="text-muted-foreground">Never</span>
                  )}
                </span>
              </span>
            </Link>
          </li>
        )
      })}
    </ul>
  )
}
