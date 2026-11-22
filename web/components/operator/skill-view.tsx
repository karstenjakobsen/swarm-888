'use client'

import Link from 'next/link'
import { Check, X } from 'lucide-react'
import { useOperator } from './store'
import { AppHeader } from './app-header'
import { Evidence } from './home-view'
import { Rev, skillSource, SourceLink, sourceOf } from './inspect-parts'
import { dayClock } from '@/lib/operator/format'
import { recordById, type Projection, type Skill } from '@/lib/operator/project'
import { cn } from '@/lib/utils'

export function SkillView({ id, rev }: { id: string; rev?: string }) {
  const { state, loaded } = useOperator()
  const skill = recordById(state.skills, id)
  return (
    <div className="flex min-h-dvh flex-col">
      <AppHeader back={{ href: '/inspect?tab=skills', label: 'Back to skills' }} />
      <main className="mx-auto w-full max-w-3xl flex-1 px-4 pb-12 pt-5">
        {!loaded ? (
          <div className="h-40 animate-pulse rounded-xl bg-card" aria-busy="true" />
        ) : skill ? (
          <Ladder skill={skill} state={state} rev={rev} />
        ) : (
          <p className="text-muted-foreground">No skill with this id.</p>
        )}
      </main>
    </div>
  )
}

function testsAt(skill: Skill, revision: string) {
  return skill.selfTests.filter((t) => t.revision === revision).at(-1)
}

function Ladder({ skill, state, rev }: { skill: Skill; state: Projection; rev?: string }) {
  const requested = rev ? skill.revisions.find((r) => r.revision === rev) : undefined
  const shown = rev ? requested : skill.revisions.find((r) => r.revision === skill.revision) ?? skill.revisions.at(-1)
  const uses = rev ? skill.uses.filter((u) => u.revision === shown?.revision) : skill.uses
  const shownTests = shown ? testsAt(skill, shown.revision) : undefined
  const shownActivation = shown ? skill.activations.filter((a) => a.revision === shown.revision).at(-1) : undefined
  const origin = skill.fromTask ? state.tasks[skill.fromTask] : undefined
  const builder = skill.builtWith ? state.skills[skill.builtWith.id] : undefined
  let n = 0

  return (
    <article className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <p className="font-mono text-xs text-muted-foreground">
          Skill · {skill.origin === 'learned' ? 'built' : 'installed'} {dayClock(skill.createdAt)}
          {skill.foundational ? ' · foundational' : ''}
        </p>
        <h1 className="break-words font-mono text-xl font-medium">{skill.name}</h1>
        <p className="text-pretty text-sm leading-relaxed text-muted-foreground">{skill.purpose}</p>
        <p className="flex flex-wrap items-center gap-2 text-sm">
          <span className="text-muted-foreground">Active revision</span>
          {skill.revision ? <Rev>{skill.revision}</Rev> : <span className="text-attention">none activated yet</span>}
        </p>
      </div>

      {rev ? (
        <div
          className={cn(
            'flex flex-col gap-1 rounded-xl border p-4 text-sm',
            requested ? 'border-primary/50 bg-primary/10' : 'border-attention/40 bg-attention/10',
          )}
          role="status"
        >
          {requested ? (
            <>
              <p>
                You opened revision <Rev>{rev}</Rev>
                {rev === skill.revision ? ', which is still the active one.' : `. The active revision is now ${skill.revision}.`}
              </p>
              <p className="text-pretty text-muted-foreground">{requested.summary}</p>
            </>
          ) : (
            <p>
              Revision <Rev>{rev}</Rev> is not in this skill&apos;s history.
            </p>
          )}
        </div>
      ) : null}

      <section className="flex flex-col gap-2" aria-label="Revisions">
        <h2 className="text-xs font-medium text-muted-foreground">Git revisions</h2>
        <ol className="flex flex-col divide-y divide-border overflow-hidden rounded-xl border border-border bg-card">
          {[...skill.revisions].reverse().map((r) => {
            const t = r.task ? state.tasks[r.task] : undefined
            const tests = testsAt(skill, r.revision)
            const passed = tests?.tests.filter((x) => x.passed).length ?? 0
            const act = skill.activations.filter((a) => a.revision === r.revision).at(-1)
            return (
              <li key={r.revision} id={`rev-${r.revision}`} className={cn('flex flex-col gap-1.5 px-4 py-3', r.revision === shown?.revision && 'bg-primary/10')}>
                <span className="flex flex-wrap items-center gap-2">
                  <Link href={`/skills/${skill.id}?rev=${r.revision}`} replace scroll={false} className="underline-offset-4 hover:underline">
                    <Rev>{r.revision}</Rev>
                  </Link>
                  {r.revision === skill.revision ? <span className="text-xs text-verified">active</span> : null}
                  <span className="ml-auto font-mono text-xs text-muted-foreground">committed {dayClock(r.at)}</span>
                </span>
                <span className="text-pretty text-sm">{r.summary}</span>
                <span className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
                  <span className={cn(tests && passed === tests.tests.length && 'text-verified')}>
                    {tests ? `Tests ${passed}/${tests.tests.length} on this revision · ${dayClock(tests.at)}` : 'Not tested on this revision'}
                  </span>
                  <span>{act ? `Activated ${dayClock(act.at)}` : 'Never activated'}</span>
                </span>
                {t ? (
                  <Link href={`/work/${t.id}`} className="text-pretty text-xs text-muted-foreground underline underline-offset-4">
                    {t.title}
                  </Link>
                ) : null}
              </li>
            )
          })}
        </ol>
      </section>

      {shown ? (
        <section className="flex flex-col gap-2" aria-label="Procedure">
          <h2 className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
            Procedure at <Rev>{shown.revision}</Rev>
          </h2>
          <ol className="flex flex-col gap-2 rounded-xl border border-border bg-card p-4 text-sm">
            {shown.procedure.map((p, i) => (
              <li key={p} className="flex gap-2.5">
                <span className="w-4 shrink-0 font-mono text-xs leading-5 text-muted-foreground">{i + 1}</span>
                <span className="text-pretty leading-relaxed">{p}</span>
              </li>
            ))}
          </ol>
          <SourceLink catalog={skill.catalog} revision={shown.revision} body={skillSource(skill, shown.revision)} />
        </section>
      ) : null}

      <p className="text-pretty rounded-xl bg-card p-4 text-sm leading-relaxed">
        These are two separate claims. <span className="font-medium">Passed its own tests</span> means the skill does what
        the operator expected on examples the operator wrote.{' '}
        <span className="font-medium text-verified">Verified on a later task</span> means its output on new input was
        checked against data collected without the skill.
      </p>

      <ol className="flex flex-col gap-4">
        <Rung n={++n} title={skill.origin === 'learned' ? 'Built' : 'Installed'} when={skill.createdAt} tone="neutral">
          {skill.origin === 'learned' ? (
            <p className="text-pretty text-sm leading-relaxed text-muted-foreground">
              Built while answering{' '}
              {origin ? (
                <Link href={`/work/${origin.id}`} className="text-foreground underline underline-offset-4">
                  {origin.title}
                </Link>
              ) : (
                skill.fromTask
              )}
              . No existing skill covered it
              {builder && skill.builtWith ? (
                <>
                  , so it used{' '}
                  <Link
                    href={`/skills/${builder.id}?rev=${skill.builtWith.revision}`}
                    className="font-mono text-foreground underline underline-offset-4"
                  >
                    {builder.name}
                  </Link>{' '}
                  <Rev>@{skill.builtWith.revision}</Rev>
                </>
              ) : null}
              .
            </p>
          ) : (
            <p className="text-pretty text-sm leading-relaxed text-muted-foreground">
              Shipped with the operator rather than learned on this VPS.
              {skill.foundational ? ' Every learned skill on this VPS was created with it.' : ''}
            </p>
          )}
        </Rung>

        {shown ? (
          shownTests ? (
            <Rung
              n={++n}
              title={`${shownTests.tests.every((t) => t.passed) ? 'Passed its own tests' : 'Self-tests'} · ${shownTests.tests.filter((t) => t.passed).length}/${shownTests.tests.length}`}
              when={shownTests.at}
              tone="self"
            >
              <p className="text-pretty text-sm leading-relaxed text-muted-foreground">
                Run against revision <Rev>{shownTests.revision}</Rev>. Tests {shownTests.authoredBy}.
              </p>
              <ul className="flex flex-col divide-y divide-border overflow-hidden rounded-lg border border-border bg-well">
                {shownTests.tests.map((t) => (
                  <li key={t.name} className="flex gap-3 px-3 py-2.5 text-sm">
                    {t.passed ? (
                      <Check className="mt-0.5 size-4 shrink-0 text-verified" aria-label="passed" />
                    ) : (
                      <X className="mt-0.5 size-4 shrink-0 text-destructive" aria-label="failed" />
                    )}
                    <span className="flex min-w-0 flex-col gap-0.5">
                      <span>{t.name}</span>
                      <span className="font-mono text-xs leading-relaxed text-muted-foreground">
                        in: {t.input} → {t.expected}
                      </span>
                    </span>
                  </li>
                ))}
              </ul>
            </Rung>
          ) : (
            <Rung n={++n} title="No self-tests on this revision" when={shown.at} tone="neutral">
              <p className="text-pretty text-sm text-muted-foreground">
                Nothing has tested <Rev>{shown.revision}</Rev> yet.
              </p>
            </Rung>
          )
        ) : null}

        {shownActivation ? (
          <Rung n={++n} title="Activated" when={shownActivation.at} tone="neutral">
            <p className="text-pretty text-sm leading-relaxed">
              <Rev>{shownActivation.revision}</Rev> became the revision the operator runs.{' '}
              <span className="text-muted-foreground">{shownActivation.reason}</span>
            </p>
            {shownActivation.task && state.tasks[shownActivation.task] ? (
              <Link href={`/work/${shownActivation.task}`} className="text-pretty text-xs text-muted-foreground underline underline-offset-4">
                {state.tasks[shownActivation.task].title}
              </Link>
            ) : null}
          </Rung>
        ) : null}

        {uses.map((u) => {
          const where = sourceOf(state, u)
          const v = skill.verifications.find((x) => x.task === u.task && x.revision === u.revision)
          const inc = u.incident ? state.incidents[u.incident] : undefined
          return (
            <Rung
              key={u.seq}
              n={++n}
              title={
                v
                  ? 'Verified on a later task'
                  : inc
                    ? 'Ran to repair an incident'
                    : u.task === skill.fromTask
                      ? 'First run, in the task that built it'
                      : 'Used on a later task'
              }
              when={u.at}
              tone={v ? 'verified' : 'neutral'}
            >
              <p className="text-pretty text-sm leading-relaxed">
                Ran{' '}
                <Link href={`/skills/${skill.id}?rev=${u.revision}`} replace scroll={false}>
                  <Rev>@{u.revision}</Rev>
                </Link>{' '}
                for{' '}
                {where ? (
                  <Link href={where.href} className="underline underline-offset-4">
                    {where.label}
                  </Link>
                ) : (
                  (u.task ?? u.incident)
                )}
                .
              </p>
              <p className="text-pretty text-sm leading-relaxed text-muted-foreground">
                <span className="text-foreground">Input:</span> {u.input}. {u.novelty}
              </p>
              {v ? (
                <div className="flex flex-col gap-2">
                  <p className="text-pretty text-sm font-medium text-verified">{v.matched}</p>
                  <p className="text-pretty text-sm leading-relaxed text-muted-foreground">{v.check}</p>
                  <Evidence command={v.command} output={v.output} seq={v.seq} />
                </div>
              ) : inc?.verification ? (
                <p className="text-pretty text-sm leading-relaxed text-muted-foreground">
                  Outcome checked on the incident: {inc.verification.check}
                </p>
              ) : (
                <p className="text-sm text-muted-foreground">No independent check yet.</p>
              )}
            </Rung>
          )
        })}
      </ol>
    </article>
  )
}

function Rung({
  n,
  title,
  when,
  tone,
  children,
}: {
  n: number
  title: string
  when: string
  tone: 'neutral' | 'self' | 'verified'
  children: React.ReactNode
}) {
  return (
    <li
      className={cn(
        'flex flex-col gap-3 rounded-2xl border bg-card p-4',
        tone === 'verified' ? 'border-verified/50' : tone === 'self' ? 'border-dashed border-muted-foreground/50' : 'border-border',
      )}
    >
      <div className="flex items-baseline gap-3">
        <span
          className={cn(
            'flex size-6 shrink-0 items-center justify-center rounded-full font-mono text-xs',
            tone === 'verified' ? 'bg-verified text-verified-foreground' : 'bg-secondary',
          )}
        >
          {n}
        </span>
        <h2 className={cn('flex-1 text-base font-medium', tone === 'verified' && 'text-verified')}>{title}</h2>
        <span className="font-mono text-xs text-muted-foreground">{dayClock(when)}</span>
      </div>
      {children}
    </li>
  )
}
