'use client'

import Link from 'next/link'
import { ChevronRight, GraduationCap, Hand, MessageSquareReply } from 'lucide-react'
import { useOperator } from './store'
import { AppHeader } from './app-header'
import { Composer } from './composer'
import { OutcomeChip } from './outcome-chip'
import { CredentialButton } from './credential-dialog'
import { plural, rowOutcome, summary, workSince, type NeedItem } from '@/lib/operator/brief'
import { clock, dayClock, duration } from '@/lib/operator/format'
import type { Goal, Projection, Skill } from '@/lib/operator/project'
import { cn } from '@/lib/utils'

export function HomeView() {
  const { state, loaded } = useOperator()
  return (
    <div className="flex min-h-dvh flex-col">
      <AppHeader />
      <main className="mx-auto w-full max-w-6xl flex-1 px-4 pb-8 pt-5">
        {loaded ? <Home state={state} /> : <Loading />}
      </main>
      <Composer />
    </div>
  )
}

function Loading() {
  return (
    <div className="flex flex-col gap-3" aria-busy="true">
      <p className="text-sm text-muted-foreground">Replaying the operator&apos;s history</p>
      {[0, 1, 2].map((i) => (
        <div key={i} className="h-20 animate-pulse rounded-xl bg-card" />
      ))}
    </div>
  )
}

function Home({ state }: { state: Projection }) {
  const s = summary(state)
  const rows = workSince(state, s.since)
  const skills = Object.values(state.skills)

  return (
    <div className="grid gap-8 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] lg:gap-10">
      <div className="flex flex-col gap-8">
        <Brief state={state} s={s} />
        <NeedsYou items={s.needs} />
      </div>
      <div className="flex flex-col gap-8">
        <section aria-labelledby="work-h" className="flex flex-col gap-3">
          <SectionTitle id="work-h" aside={state.ownerLeft ? `since ${clock(state.ownerLeft.at)}` : undefined}>
            What happened
          </SectionTitle>
          <ul className="flex flex-col divide-y divide-border overflow-hidden rounded-xl border border-border bg-card">
            {rows.map((r) => {
              const o = rowOutcome(r)
              return (
                <li key={r.id}>
                  <Link href={`/work/${r.id}`} className="flex min-h-16 items-center gap-3 px-4 py-3 hover:bg-secondary/60">
                    <span className="w-11 shrink-0 font-mono text-xs text-muted-foreground">{clock(r.at)}</span>
                    <span className="flex min-w-0 flex-1 flex-col gap-1.5">
                      <span className="flex items-center gap-2 text-xs text-muted-foreground">
                        {r.kind === 'incident' ? 'Incident' : r.task.source === 'schedule' ? 'Scheduled' : 'Your task'}
                      </span>
                      <span className="text-pretty text-sm font-medium leading-snug">{r.title}</span>
                      <OutcomeChip outcome={o} className="self-start" />
                    </span>
                    <ChevronRight className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                  </Link>
                </li>
              )
            })}
          </ul>
        </section>

        <Goals goals={state.goalOrder.map((id) => state.goals[id])} />

        {skills.length ? (
          <section aria-labelledby="skills-h" className="flex flex-col gap-3">
            <SectionTitle id="skills-h">What it learned</SectionTitle>
            {skills.map((sk) => (
              <SkillCard key={sk.id} skill={sk} />
            ))}
          </section>
        ) : null}
      </div>
    </div>
  )
}

function SectionTitle({ id, children, aside }: { id: string; children: React.ReactNode; aside?: string }) {
  return (
    <h2 id={id} className="flex items-baseline justify-between gap-3 text-sm font-semibold">
      {children}
      {aside ? <span className="font-mono text-xs font-normal text-muted-foreground">{aside}</span> : null}
    </h2>
  )
}

function Brief({ state, s }: { state: Projection; s: ReturnType<typeof summary> }) {
  const resolved = s.resolved.length
  const open = s.incidents.length - resolved
  const happened = [
    `${plural(s.finished.length, 'task')} finished`,
    s.running.length ? `${s.running.length} still running` : null,
  ]
    .filter(Boolean)
    .join(', ')
  const incidents = s.incidents.length
    ? `${plural(s.incidents.length, 'incident')}: ${[resolved ? `${resolved} resolved` : null, open ? `${open} open` : null].filter(Boolean).join(', ')}.`
    : 'No incidents.'

  return (
    <section aria-labelledby="brief-h" className="rise flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <p className="font-mono text-xs text-muted-foreground">
          {state.ownerLeft ? `You left at ${clock(state.ownerLeft.at)} · ${duration(state.ownerLeft.at)} ago` : 'Overview'}
        </p>
        <h1 id="brief-h" className="sr-only">
          Morning brief
        </h1>
      </div>
      <dl className="flex flex-col overflow-hidden rounded-2xl border border-border bg-card">
        <BriefRow q="What happened?">
          <span>
            {happened}. {incidents}
          </span>
        </BriefRow>
        <BriefRow q="Is the VPS as you asked?">
          {s.goals.length === 0 ? <span>No standing goals configured.</span> : s.off.length === 0 ? (
            <span>All {s.goals.length} standing goals hold.</span>
          ) : (
            <span className="flex flex-col gap-2">
              <span>
                {s.holding.length} of {s.goals.length} standing goals hold.
              </span>
              <span className="flex flex-col gap-1.5">
                {s.off.map((g) => (
                  <span key={g.id} className="flex gap-2 text-sm font-normal leading-relaxed">
                    <span className="mt-2 size-1.5 shrink-0 rounded-full bg-attention" aria-hidden="true" />
                    <span className="text-pretty">
                      <span className="text-muted-foreground">{g.text}.</span> {g.observed ?? g.status}
                    </span>
                  </span>
                ))}
              </span>
            </span>
          )}
        </BriefRow>
        <BriefRow q="Does anything need you?" tone={s.needs.length ? 'attention' : 'calm'}>
          {s.needs.length ? (
            <span>
              {s.needs.length === 1 ? 'Yes, one thing.' : `Yes, ${s.needs.length} things.`}{' '}
              <span className="text-muted-foreground">Each is paused until you act.</span>
            </span>
          ) : (
            <span>Nothing. Everything is moving on its own.</span>
          )}
        </BriefRow>
      </dl>
    </section>
  )
}

function BriefRow({ q, children, tone }: { q: string; children: React.ReactNode; tone?: 'attention' | 'calm' }) {
  return (
    <div
      className={cn(
        'flex flex-col gap-1 border-b border-border px-4 py-4 last:border-b-0',
        tone === 'attention' && 'bg-attention/10',
      )}
    >
      <dt className={cn('text-xs font-medium', tone === 'attention' ? 'text-attention' : 'text-muted-foreground')}>{q}</dt>
      <dd className="text-pretty text-lg font-medium leading-snug">{children}</dd>
    </div>
  )
}

function NeedsYou({ items }: { items: NeedItem[] }) {
  if (!items.length) return null
  return (
    <section aria-labelledby="needs-h" className="flex flex-col gap-3">
      <SectionTitle id="needs-h">Needs you</SectionTitle>
      <ul className="flex flex-col gap-3">
        {items.map((n) => (
          <li key={`${n.kind}-${n.id}`} className="rise flex flex-col gap-3 rounded-2xl border border-attention/40 bg-card p-4">
            {n.kind === 'decision' ? (
              <>
                <Kicker icon={<Hand className="size-3.5" aria-hidden="true" />} text={`Decision · incident at ${clock(n.incident.openedAt)}`} />
                <p className="text-pretty text-base font-medium leading-snug">{n.incident.decision?.question}</p>
                <p className="text-pretty text-sm leading-relaxed text-muted-foreground">
                  {n.incident.decision?.uncertain[0]}
                </p>
                <Link
                  href={`/work/${n.incident.id}`}
                  className="flex min-h-11 items-center justify-center rounded-lg bg-attention px-4 text-sm font-medium text-attention-foreground hover:opacity-90"
                >
                  Review evidence and decide
                </Link>
              </>
            ) : n.kind === 'unknown' ? (
              <>
                <Kicker icon={<Hand className="size-3.5" aria-hidden="true" />} text="Outcome unknown" />
                <p className="text-pretty text-base font-medium">{n.incident.unknown?.summary}</p>
                <Link href={`/work/${n.incident.id}`}
                  className="flex min-h-11 items-center justify-center rounded-lg bg-attention px-4 text-sm font-medium text-attention-foreground">
                  Review recovery evidence
                </Link>
              </>
            ) : n.kind === 'credential' ? (
              <>
                <Kicker icon={<Hand className="size-3.5" aria-hidden="true" />} text={`Credential · paused since ${clock(n.at)}`} />
                <p className="text-pretty text-base font-medium leading-snug">{n.credential.label}</p>
                <p className="text-pretty text-sm leading-relaxed text-muted-foreground">
                  For <Link href={`/work/${n.task.id}`} className="text-foreground underline underline-offset-4">{n.task.title}</Link>.
                  Sent only to <span className="font-mono text-xs text-foreground">{n.credential.destination}</span>.
                </p>
                <CredentialButton credential={n.credential} taskTitle={n.task.title} />
              </>
            ) : (
              <>
                <Kicker icon={<MessageSquareReply className="size-3.5" aria-hidden="true" />} text="Waiting for your reply" />
                <p className="text-pretty text-base font-medium leading-snug">{n.task.title}</p>
                <Link
                  href={`/work/${n.task.id}`}
                  className="flex min-h-11 items-center justify-center rounded-lg bg-attention px-4 text-sm font-medium text-attention-foreground hover:opacity-90"
                >
                  Open and reply
                </Link>
              </>
            )}
          </li>
        ))}
      </ul>
    </section>
  )
}

function Kicker({ icon, text }: { icon: React.ReactNode; text: string }) {
  return (
    <p className="flex items-center gap-1.5 text-xs font-medium text-attention">
      {icon}
      {text}
    </p>
  )
}

const goalTone: Record<Goal['status'], string> = {
  holding: 'bg-verified',
  drift: 'bg-attention',
  blocked: 'bg-attention',
  unknown: 'bg-muted-foreground',
}
const goalWord: Record<Goal['status'], string> = { holding: 'Holding', drift: 'Drifted', blocked: 'Blocked', unknown: 'Not checked' }

function Goals({ goals }: { goals: Goal[] }) {
  return (
    <section aria-labelledby="goals-h" className="flex flex-col gap-3">
      <SectionTitle id="goals-h">Standing goals</SectionTitle>
      <ul className="flex flex-col divide-y divide-border rounded-xl border border-border bg-card">
        {goals.map((g) => (
          <li key={g.id} id={g.id}>
            <details className="group">
              <summary className="flex min-h-14 cursor-pointer items-center gap-3 px-4 py-3">
                <span className={cn('size-2.5 shrink-0 rounded-full', goalTone[g.status])} aria-hidden="true" />
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="text-pretty text-sm">{g.text}</span>
                  <span className="text-xs text-muted-foreground">
                    <span className={g.status === 'holding' ? 'text-verified' : 'text-attention'}>
                      {g.lifecycle === 'paused' ? 'Paused' : g.lifecycle === 'retired' ? 'Retired' : goalWord[g.status]}
                    </span>
                    {g.observed ? ` · ${g.observed}` : ''}
                  </span>
                </span>
                <span className="shrink-0 font-mono text-xs text-muted-foreground">{g.checkedAt ? clock(g.checkedAt) : ''}</span>
              </summary>
              {g.command ? (
                <div className="px-4 pb-4">
                  <Evidence command={g.command} output={g.output} seq={g.checkedSeq} />
                </div>
              ) : null}
            </details>
          </li>
        ))}
      </ul>
    </section>
  )
}

export function Evidence({ command, output, seq }: { command?: string; output?: string; seq?: number }) {
  return (
    <div className="overflow-hidden rounded-lg border border-border bg-well">
      {command ? (
        <pre className="overflow-x-auto whitespace-pre-wrap break-words border-b border-border px-3 py-2 font-mono text-xs leading-relaxed">
          <span className="select-none text-muted-foreground">$ </span>
          {command}
        </pre>
      ) : null}
      {output ? (
        <pre className="overflow-x-auto whitespace-pre-wrap break-words px-3 py-2 font-mono text-xs leading-relaxed text-muted-foreground">
          {output}
        </pre>
      ) : null}
      {seq ? <p className="border-t border-border px-3 py-1.5 font-mono text-[11px] text-muted-foreground">event #{seq}</p> : null}
    </div>
  )
}

function SkillCard({ skill }: { skill: Skill }) {
  const tests = skill.selfTests.filter((t) => t.revision === skill.revision).at(-1)?.tests ?? []
  const passed = tests.filter((t) => t.passed).length
  const verified = skill.verifications.filter((v) => v.revision === skill.revision).length
  return (
    <Link href={`/skills/${skill.id}`} className="flex flex-col gap-3 rounded-xl border border-border bg-card p-4 hover:bg-secondary/60">
      <div className="flex items-start gap-3">
        <GraduationCap className="mt-0.5 size-5 shrink-0 text-muted-foreground" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <p className="font-mono text-sm">{skill.name}</p>
          <p className="mt-1 text-pretty text-sm leading-relaxed text-muted-foreground">{skill.purpose}</p>
        </div>
        <ChevronRight className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
      </div>
      <ol className="flex flex-wrap gap-2 text-xs" aria-label="Skill progression">
        <li className="rounded-full bg-secondary px-2.5 py-1">Built {dayClock(skill.createdAt)}</li>
        <li className="rounded-full border border-dashed border-muted-foreground/60 px-2.5 py-1 text-muted-foreground">
          {tests.length ? `Self-tests passed ${passed}/${tests.length}` : 'No self-tests recorded'}
        </li>
        <li className={cn('rounded-full px-2.5 py-1', verified ? 'bg-verified/15 text-verified' : 'bg-secondary text-muted-foreground')}>
          {verified ? `Verified on later task · ${verified}` : 'Not yet verified on new input'}
        </li>
      </ol>
    </Link>
  )
}
