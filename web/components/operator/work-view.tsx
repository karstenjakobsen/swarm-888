'use client'

import Link from 'next/link'
import { useState } from 'react'
import { BookOpen, Check, CircleSlash, FolderGit2, GraduationCap, PenLine, Plug } from 'lucide-react'
import { current, Rev, RowLink } from './inspect-parts'
import { useOperator } from './store'
import { AppHeader } from './app-header'
import { Composer } from './composer'
import { OutcomeChip } from './outcome-chip'
import { EvidenceTrail } from './evidence-trail'
import { CredentialButton } from './credential-dialog'
import { Evidence } from './home-view'
import { recordById, incidentOutcome, isTaskFinished, taskOutcome, type Incident, type Projection, type Task } from '@/lib/operator/project'
import { clock, dayClock } from '@/lib/operator/format'
import { cn } from '@/lib/utils'

export function WorkView({ id }: { id: string }) {
  const { state, loaded, mode } = useOperator()
  const task = recordById(state.tasks, id)
  const incident = recordById(state.incidents, id)
  return (
    <div className="flex min-h-dvh flex-col">
      <AppHeader back={{ href: '/', label: 'Back to brief' }} />
      <main className="mx-auto w-full max-w-3xl flex-1 px-4 pb-10 pt-5">
        {!loaded ? (
          <div className="h-40 animate-pulse rounded-xl bg-card" aria-busy="true" />
        ) : task ? (
          <TaskDetail task={task} state={state} />
        ) : incident ? (
          <IncidentDetail incident={incident} state={state} />
        ) : (
          <p className="text-muted-foreground">Nothing with this id in the operator&apos;s history.</p>
        )}
      </main>
      {mode === 'demo' && task && !isTaskFinished(task) ? (
        <Composer taskId={task.id} placeholder={task.waiting?.on === 'reply' ? 'Reply, e.g. "apply"' : 'Steer this task'} />
      ) : (
        <Composer />
      )}
    </div>
  )
}

function Section({ title, children, className }: { title: string; children: React.ReactNode; className?: string }) {
  return (
    <section className={cn('flex flex-col gap-2', className)}>
      <h2 className="text-xs font-medium text-muted-foreground">{title}</h2>
      {children}
    </section>
  )
}

function UsedInTask({ task, state }: { task: Task; state: Projection }) {
  const u = task.used
  const byConnector = new Map<string, string[]>()
  for (const c of u.connectors) {
    const tools = byConnector.get(c.connector) ?? []
    if (!tools.includes(c.tool)) tools.push(c.tool)
    byConnector.set(c.connector, tools)
  }
  const reads = u.memoriesRead.filter((r, i, all) => all.findIndex((x) => x.memory === r.memory) === i)
  const runs = u.skillRuns.filter((r, i, all) => all.findIndex((x) => x.skill === r.skill && x.revision === r.revision) === i)
  const tested = u.skillsBuilt.flatMap((b) =>
    (state.skills[b.skill]?.selfTests ?? [])
      .filter((t) => t.task === task.id)
      .map((t) => ({ skill: b.skill, revision: t.revision, seq: t.seq, passed: t.tests.filter((x) => x.passed).length, total: t.tests.length })),
  )
  const skillRows = [
    ...u.skillsBuilt.map((r) => ({ ...r, verb: 'Built skill', detail: undefined as React.ReactNode })),
    ...tested.map((r) => ({ ...r, verb: 'Tested revision', detail: `${r.passed}/${r.total} self-tests passed` as React.ReactNode })),
    ...u.skillActivations.map((r) => ({
      ...r,
      verb: 'Activated revision',
      detail: state.skills[r.skill]?.activations.find((a) => a.seq === r.seq)?.reason as React.ReactNode,
    })),
    ...runs.map((r) => ({ ...r, verb: 'Ran skill', detail: undefined as React.ReactNode })),
  ].sort((a, b) => a.seq - b.seq)
  const project = task.project ? state.projects[task.project] : undefined
  if (!reads.length && !skillRows.length && !byConnector.size && !u.memoriesWritten.length && !project) return null

  return (
    <>
      {reads.length || skillRows.length || byConnector.size || project ? (
        <Section title="Used in this task">
          <ul className="flex flex-col divide-y divide-border overflow-hidden rounded-xl border border-border bg-card">
            {project ? (
              <RowLink
                href={`/inspect/projects/${project.id}`}
                icon={<FolderGit2 className="size-4" />}
                kicker="Project"
                title={project.name}
                detail={
                  <span className="flex flex-col font-mono">
                    <span>{project.hostname}</span>
                    <span>configured upstream {project.upstream}</span>
                  </span>
                }
              />
            ) : null}
            {reads.map((r) => (
              <RowLink
                key={`m-${r.seq}`}
                href={`/inspect/memory/${r.memory}`}
                icon={<BookOpen className="size-4" />}
                kicker="Read memory"
                title={state.memories[r.memory]?.title ?? r.memory}
                detail={r.why}
              />
            ))}
            {skillRows.map((r) => (
              <RowLink
                key={`s-${r.verb}-${r.seq}`}
                href={`/skills/${r.skill}?rev=${r.revision}`}
                icon={<GraduationCap className="size-4" />}
                kicker={`${r.verb} · #${r.seq}`}
                title={
                  <>
                    <span className="font-mono">{state.skills[r.skill]?.name ?? r.skill}</span> <Rev>@{r.revision}</Rev>
                  </>
                }
                detail={r.detail}
              />
            ))}
            {[...byConnector].map(([id, tools]) => (
              <RowLink
                key={`c-${id}`}
                href={`/inspect/connectors/${id}`}
                icon={<Plug className="size-4" />}
                kicker="Used connector"
                title={state.connectors[id]?.name ?? id}
                detail={<span className="font-mono">{tools.join(', ')}</span>}
              />
            ))}
          </ul>
        </Section>
      ) : null}
      <MemoryWritten state={state} ids={u.memoriesWritten.map((w) => w.memory)} />
    </>
  )
}

function MemoryWritten({ state, ids }: { state: Projection; ids: string[] }) {
  const unique = [...new Set(ids)].filter((id) => state.memories[id])
  if (!unique.length) return null
  return (
    <Section title="Memory written">
      <ul className="flex flex-col gap-2">
        {unique.map((id) => {
          const m = state.memories[id]
          const v = current(m)
          return (
            <li key={id}>
              <Link
                href={`/inspect/memory/${id}`}
                className="flex flex-col gap-2 rounded-xl border border-border bg-card p-4 hover:bg-secondary/40"
              >
                <span className="flex items-center gap-2 text-sm font-medium">
                  <PenLine className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                  <span className="text-pretty">{m.title}</span>
                </span>
                <span className="text-pretty text-sm leading-relaxed text-muted-foreground">{v.text}</span>
                <span className="font-mono text-xs text-muted-foreground">
                  {m.versions.length > 1 ? 'updated' : 'written'} {dayClock(v.at)} · #{v.seq}
                </span>
              </Link>
            </li>
          )
        })}
      </ul>
    </Section>
  )
}

function Head({ kicker, title, outcome }: { kicker: string; title: string; outcome: ReturnType<typeof taskOutcome> }) {
  return (
    <div className="flex flex-col gap-3">
      <p className="font-mono text-xs text-muted-foreground">{kicker}</p>
      <h1 className="text-balance text-2xl font-semibold leading-tight">{title}</h1>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <OutcomeChip outcome={outcome} size="md" />
        <a href={`#e-${outcome.seq}`} className="font-mono text-xs text-muted-foreground underline underline-offset-4">
          from event #{outcome.seq}
        </a>
      </div>
    </div>
  )
}

function TaskDetail({ task, state }: { task: Task; state: Projection }) {
  const { send, mode } = useOperator()
  const [stopping, setStopping] = useState(false)
  const outcome = taskOutcome(task)
  const cred = task.credentialRequest ? state.credentials[task.credentialRequest] : undefined
  const lateAnswer = task.answer && task.verification && task.answer.seq > task.verification.seq
  const sourceWord = task.source === 'owner' ? 'You asked' : task.source === 'schedule' ? 'Scheduled' : 'Started by incident'

  return (
    <article className="flex flex-col gap-7">
      <Head kicker={`${sourceWord} · ${dayClock(task.receivedAt)}`} title={task.title} outcome={outcome} />

      {task.waiting?.on === 'credential' && cred && !cred.supplied ? (
        <div className="flex flex-col gap-3 rounded-2xl border border-attention/40 bg-attention/10 p-4">
          <p className="text-pretty text-sm leading-relaxed">
            Paused at step {task.plan.findIndex((p) => /upload|s3/i.test(p)) + 1 || '?'} of {task.plan.length}. Needs{' '}
            <span className="font-medium">{cred.label}</span>, which will be sent only to{' '}
            <span className="font-mono text-xs">{cred.destination}</span>. This same task resumes as soon as it arrives.
          </p>
          <CredentialButton credential={cred} taskTitle={task.title} />
        </div>
      ) : null}

      {task.answer ? (
        <Section title="Answer">
          <p className="text-pretty text-lg leading-snug">{task.answer.text}</p>
        </Section>
      ) : null}

      {task.verification ? (
        <Section title="How it was checked">
          <div className="flex flex-col gap-3 rounded-xl border border-border bg-card p-4">
            <span
              className={cn(
                'self-start rounded-full px-2.5 py-1 text-xs font-medium',
                task.verification.method === 'independent'
                  ? 'bg-verified/15 text-verified'
                  : 'border border-dashed border-muted-foreground/60 text-muted-foreground',
              )}
            >
              {task.verification.method === 'independent' ? 'Independent check' : 'Self-check: same source as the answer'}
            </span>
            <p className="text-pretty text-sm leading-relaxed">{task.verification.check}</p>
            {task.verification.claims?.length ? (
              <ul className="flex flex-col gap-4" aria-label="Claims checked">
                {task.verification.claims.map((c) => (
                  <li key={c.claim} className="flex flex-col gap-2 border-t border-border pt-3">
                    <p className="flex items-start gap-2 text-sm font-medium">
                      <Check className="mt-0.5 size-4 shrink-0 text-verified" aria-label="confirmed" />
                      <span className="text-pretty">{c.claim}</span>
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {c.method === 'independent' ? 'Checked independently, outside the operator' : 'Checked by the operator itself'}
                    </p>
                    <Evidence command={c.command} output={c.output} />
                  </li>
                ))}
              </ul>
            ) : (
              <Evidence command={task.verification.command} output={task.verification.output} seq={task.verification.seq} />
            )}
            {lateAnswer ? (
              <p className="text-pretty text-xs leading-relaxed text-muted-foreground">
                The answer (#{task.answer!.seq}) was recorded after its verification (#{task.verification.seq}). The status
                stays {outcome.label.toLowerCase()} because it comes from the evidence, not from whichever event arrived
                last.
              </p>
            ) : null}
          </div>
        </Section>
      ) : null}

      {task.interpretation ? (
        <Section title="What it understood">
          <p className="text-pretty text-sm leading-relaxed">
            {task.interpretation.split('`').map((part, i) =>
              i % 2 ? (
                <code key={i} className="rounded bg-secondary px-1 font-mono text-xs">
                  {part}
                </code>
              ) : (
                part
              ),
            )}
          </p>
          {task.plan.length ? (
            <ol className="mt-1 flex flex-col gap-1.5 text-sm text-muted-foreground">
              {task.plan.map((p, i) => (
                <li key={p} className="flex gap-2">
                  <span className="w-4 shrink-0 font-mono text-xs leading-5">{i + 1}</span>
                  <span className="text-pretty">{p}</span>
                </li>
              ))}
            </ol>
          ) : null}
        </Section>
      ) : null}

      <UsedInTask task={task} state={state} />

      {task.incident ? (
        <div className="flex flex-col gap-2">
          {task.incident && state.incidents[task.incident] ? (
            <Link href={`/work/${task.incident}`} className="flex min-h-12 items-center gap-3 rounded-xl border border-border bg-card px-4 text-sm hover:bg-secondary/60">
              <span className="min-w-0 flex-1 text-pretty">Part of incident: {state.incidents[task.incident].symptom}</span>
              <OutcomeChip outcome={incidentOutcome(state.incidents[task.incident])} />
            </Link>
          ) : null}
        </div>
      ) : null}

      <Section title="Evidence trail">
        <EvidenceTrail items={task.trail} outcomeSeq={outcome.seq} />
      </Section>

      {mode === 'demo' && !isTaskFinished(task) ? (
        <button
          type="button"
          disabled={stopping}
          onClick={async () => {
            setStopping(true)
            await send({ kind: 'stop', taskId: task.id })
            setStopping(false)
          }}
          className="flex min-h-11 items-center justify-center gap-2 self-start rounded-lg border border-border px-4 text-sm hover:bg-secondary disabled:opacity-50"
        >
          <CircleSlash className="size-4" aria-hidden="true" />
          Stop this task
        </button>
      ) : null}
    </article>
  )
}

function IncidentDetail({ incident, state }: { incident: Incident; state: Projection }) {
  const outcome = incidentOutcome(incident)
  const d = incident.decision
  return (
    <article className="flex flex-col gap-7">
      <Head kicker={`Incident · ${incident.severity} · detected ${clock(incident.openedAt)}`} title={incident.symptom} outcome={outcome} />

      <dl className="flex flex-col overflow-hidden rounded-2xl border border-border bg-card">
        <Fact label="Affected">
          <span className="font-mono text-sm">{incident.resource}</span>
          <span className="text-sm text-muted-foreground">{incident.detectedBy}</span>
        </Fact>
        {incident.skillRuns.length ? (
          <Fact label="Skill it followed">
            <ul className="flex flex-col">
              {incident.skillRuns
                .filter((r, i, all) => all.findIndex((x) => x.skill === r.skill && x.revision === r.revision) === i)
                .map((r) => (
                  <li key={r.seq}>
                    <Link href={`/skills/${r.skill}?rev=${r.revision}`} className="flex min-h-11 items-center gap-2 text-sm">
                      <GraduationCap className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                      <span className="font-mono underline underline-offset-4">{state.skills[r.skill]?.name ?? r.skill}</span>
                      <Rev>@{r.revision}</Rev>
                    </Link>
                  </li>
                ))}
            </ul>
          </Fact>
        ) : null}
        {incident.changes.length ? (
          <Fact label="What it changed">
            <ul className="flex flex-col gap-2.5">
              {incident.changes.map((c) => (
                <li key={c.seq} className="flex flex-col gap-1 text-pretty text-sm">
                  <a href={`#e-${c.seq}`} className="hover:underline">
                    {c.title}
                  </a>
                  {c.skill ? (
                    <Link href={`/skills/${c.skill.id}?rev=${c.skill.revision}`} className="flex items-center gap-1.5 text-xs text-muted-foreground">
                      via <span className="font-mono underline underline-offset-4">{state.skills[c.skill.id]?.name ?? c.skill.id}</span>
                      <Rev>@{c.skill.revision}</Rev>
                    </Link>
                  ) : null}
                </li>
              ))}
            </ul>
          </Fact>
        ) : null}
        {incident.verification ? (
          <Fact label="How recovery was verified" tone="good">
            <span className="text-pretty text-sm">{incident.verification.check}</span>
            <Evidence command={incident.verification.command} output={incident.verification.output} seq={incident.verification.seq} />
          </Fact>
        ) : null}
        {d && !incident.resolved ? (
          <>
            <Fact label="What it knows">
              <ul className="flex flex-col gap-1.5">
                {d.known.map((k) => (
                  <li key={k} className="text-pretty text-sm leading-relaxed">
                    {k}
                  </li>
                ))}
              </ul>
            </Fact>
            <Fact label="What is uncertain" tone="attention">
              <ul className="flex flex-col gap-1.5">
                {d.uncertain.map((k) => (
                  <li key={k} className="text-pretty text-sm leading-relaxed">
                    {k}
                  </li>
                ))}
              </ul>
            </Fact>
          </>
        ) : null}
      </dl>

      {d && !incident.resolved ? <DecisionPanel incident={incident} /> : null}

      {incident.relatedTasks.length ? (
        <Section title="Work it did on its own">
          {incident.relatedTasks.map((tid) => {
            const t = state.tasks[tid]
            return (
              <Link key={tid} href={`/work/${tid}`} className="flex min-h-14 items-center gap-3 rounded-xl border border-border bg-card px-4 py-3 hover:bg-secondary/60">
                <span className="min-w-0 flex-1 text-pretty text-sm">{t.title}</span>
                <OutcomeChip outcome={taskOutcome(t)} />
              </Link>
            )
          })}
        </Section>
      ) : null}

      <MemoryWritten
        state={state}
        ids={state.memoryOrder.filter((id) => state.memories[id].versions.some((v) => v.source.incident === incident.id))}
      />

      <Section title="Evidence trail">
        <EvidenceTrail items={incident.trail} outcomeSeq={outcome.seq} />
      </Section>
    </article>
  )
}

function Fact({ label, children, tone }: { label: string; children: React.ReactNode; tone?: 'good' | 'attention' }) {
  return (
    <div className="flex flex-col gap-1.5 border-b border-border px-4 py-4 last:border-b-0">
      <dt className={cn('text-xs font-medium', tone === 'good' ? 'text-verified' : tone === 'attention' ? 'text-attention' : 'text-muted-foreground')}>
        {label}
      </dt>
      <dd className="flex flex-col gap-2">{children}</dd>
    </div>
  )
}

function DecisionPanel({ incident }: { incident: Incident }) {
  const { send } = useOperator()
  const d = incident.decision!
  const [choice, setChoice] = useState<string | null>(d.options.find((o) => o.recommended)?.id ?? null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  if (d.decided) {
    return (
      <div className="rounded-2xl border border-border bg-card p-4 text-sm">
        You chose <span className="font-medium">{d.decided.label}</span> at {clock(d.decided.at)}. Progress appears in the trail below.
      </div>
    )
  }

  return (
    <fieldset className="flex flex-col gap-3 rounded-2xl border border-attention/40 bg-attention/10 p-4">
      <legend className="sr-only">Your decision</legend>
      <p className="text-xs font-medium text-attention">What it needs from you</p>
      <p className="text-pretty text-base font-medium leading-snug">{d.question}</p>
      <div className="flex flex-col gap-2" role="radiogroup">
        {d.options.map((o) => (
          <label
            key={o.id}
            className={cn(
              'flex min-h-14 cursor-pointer gap-3 rounded-xl border bg-card p-3',
              choice === o.id ? 'border-attention ring-1 ring-attention' : 'border-border',
            )}
          >
            <input
              type="radio"
              name="decision"
              value={o.id}
              checked={choice === o.id}
              onChange={() => setChoice(o.id)}
              className="mt-1 size-4 accent-[var(--attention)]"
            />
            <span className="flex min-w-0 flex-col gap-1">
              <span className="text-sm font-medium">
                {o.label}
                {o.recommended ? <span className="ml-2 text-xs font-normal text-muted-foreground">operator&apos;s pick</span> : null}
              </span>
              <span className="text-pretty text-sm leading-relaxed text-muted-foreground">{o.consequence}</span>
            </span>
          </label>
        ))}
      </div>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      <button
        type="button"
        disabled={!choice || busy}
        onClick={async () => {
          if (!choice) return
          setBusy(true)
          setError(null)
          const res = await send({ kind: 'decide', requestId: d.requestId, optionId: choice })
          setBusy(false)
          if (!res.ok) setError(res.error ?? 'Could not send decision.')
        }}
        className="flex min-h-12 items-center justify-center rounded-lg bg-attention px-4 text-base font-medium text-attention-foreground hover:opacity-90 disabled:opacity-50"
      >
        {busy ? 'Sending' : 'Confirm decision'}
      </button>
      <p className="text-xs text-muted-foreground">Or reply below in your own words.</p>
    </fieldset>
  )
}
