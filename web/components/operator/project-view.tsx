'use client'

import Link from 'next/link'
import { BookOpen } from 'lucide-react'
import { useOperator } from './store'
import { AppHeader } from './app-header'
import { OutcomeChip } from './outcome-chip'
import { Meta, projectSource, RowLink, SourceLink } from './inspect-parts'
import { taskOutcome } from '@/lib/operator/project'
import { dayClock } from '@/lib/operator/format'

export function ProjectView({ id }: { id: string }) {
  const { state, loaded } = useOperator()
  const p = state.projects[id]
  const mem = p?.memory ? state.memories[p.memory] : undefined
  return (
    <div className="flex min-h-dvh flex-col">
      <AppHeader back={{ href: '/inspect?tab=projects', label: 'Back to projects' }} />
      <main className="mx-auto w-full max-w-3xl flex-1 px-4 pb-12 pt-5">
        {!loaded ? (
          <div className="h-40 animate-pulse rounded-xl bg-card" aria-busy="true" />
        ) : !p ? (
          <p className="text-muted-foreground">No project with this id.</p>
        ) : (
          <article className="flex flex-col gap-6">
            <div className="flex flex-col gap-2">
              <p className="font-mono text-xs text-muted-foreground">Project · registered {dayClock(p.registeredAt)} · #{p.registeredSeq}</p>
              <h1 className="text-2xl font-semibold">{p.name}</h1>
              <p className="text-pretty text-sm leading-relaxed text-muted-foreground">{p.description}</p>
            </div>

            <div className="rounded-xl border border-border bg-card p-4">
              <Meta
                rows={[
                  ['Hostname', <span key="h" className="font-mono">{p.hostname}</span>],
                  ['App repo', <span key="r" className="break-all font-mono">{p.repo}</span>],
                  ['Upstream', <span key="u" className="font-mono">{p.upstream}</span>],
                ]}
              />
            </div>

            <SourceLink catalog={p.catalog} body={projectSource(p)} />

            {mem ? (
              <section className="flex flex-col gap-2">
                <h2 className="text-xs font-medium text-muted-foreground">What the operator remembers about it</h2>
                <ul className="overflow-hidden rounded-xl border border-border bg-card">
                  <RowLink href={`/inspect/memory/${mem.id}`} icon={<BookOpen className="size-4" />} kicker="Memory" title={mem.title} />
                </ul>
              </section>
            ) : null}

            <section className="flex flex-col gap-2">
              <h2 className="text-xs font-medium text-muted-foreground">Related tasks</h2>
              {p.relatedTasks.length ? (
                <ul className="flex flex-col gap-2">
                  {p.relatedTasks.map((tid) => {
                    const t = state.tasks[tid]
                    if (!t) return null
                    return (
                      <li key={tid}>
                        <Link
                          href={`/work/${tid}`}
                          className="flex min-h-14 items-center gap-3 rounded-xl border border-border bg-card px-4 py-3 hover:bg-secondary/60"
                        >
                          <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                            <span className="text-pretty text-sm">{t.title}</span>
                            <span className="font-mono text-xs text-muted-foreground">{dayClock(t.receivedAt)}</span>
                          </span>
                          <OutcomeChip outcome={taskOutcome(t)} />
                        </Link>
                      </li>
                    )
                  })}
                </ul>
              ) : (
                <p className="rounded-xl bg-card p-4 text-sm text-muted-foreground">No tasks yet.</p>
              )}
            </section>
          </article>
        )}
      </main>
    </div>
  )
}
