import Link from 'next/link'
import { ChevronRight, FileCode2 } from 'lucide-react'
import type { Connector, Memory, MemoryVersion, Project, Projection, Skill } from '@/lib/operator/project'
import type { CatalogSource } from '@/lib/operator/types'
import { cn } from '@/lib/utils'

export function SourceLink({ catalog, revision, body }: { catalog: CatalogSource; revision?: string; body?: string }) {
  return (
    <details className="group rounded-xl border border-border bg-card text-xs">
      <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 px-3 [&::-webkit-details-marker]:hidden">
        <FileCode2 className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        <span className="text-muted-foreground">Source</span>
        <span className="min-w-0 flex-1 truncate font-mono text-foreground">{catalog.path}</span>
        <ChevronRight className="size-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-90" aria-hidden="true" />
      </summary>
      <div className="flex flex-col gap-2 border-t border-border px-3 py-3">
        <p className="break-all font-mono leading-relaxed">
          <span className="text-muted-foreground">{catalog.repo}</span>
          {revision ? <span className="text-muted-foreground">@{revision}</span> : null}
          <br />
          {catalog.path}
        </p>
        <p className="text-pretty leading-relaxed text-muted-foreground">
          Definition in the simulated external Git catalog. Read-only here; changes land as commits there.
        </p>
        {body ? (
          <pre className="overflow-x-auto whitespace-pre-wrap break-words rounded-lg bg-well p-3 font-mono leading-relaxed text-muted-foreground">
            {body}
          </pre>
        ) : null}
      </div>
    </details>
  )
}

export function skillSource(skill: Skill, revision: string) {
  const r = skill.revisions.find((x) => x.revision === revision)
  return [
    `name: ${skill.name}`,
    `revision: ${revision}`,
    `purpose: ${skill.purpose}`,
    'procedure:',
    ...(r?.procedure ?? []).map((p, i) => `  ${i + 1}. ${p}`),
  ].join('\n')
}

export function connectorSource(c: Connector) {
  return [
    `name: ${c.name}`,
    `provider: ${c.provider}`,
    ...(c.manages ? [`manages: { ${c.manages.label.toLowerCase().replace(/\s+/g, '_')}: ${c.manages.value} }`] : []),
    `scope: ${c.scope}`,
    `credential: vault://${c.id}  # value never leaves the vault`,
    'tools:',
    ...c.tools.map((t) => `  - ${t.name}  # ${t.access}`),
  ].join('\n')
}

export function projectSource(p: Project) {
  return [`name: ${p.name}`, `hostname: ${p.hostname}`, `repo: ${p.repo}`, `upstream: ${p.upstream}`, `description: ${p.description}`].join('\n')
}

export function useLabel(state: Projection, u: { task?: string; incident?: string }) {
  if (u.task && state.tasks[u.task]) return { href: `/work/${u.task}`, label: state.tasks[u.task].title }
  if (u.incident && state.incidents[u.incident])
    return { href: `/work/${u.incident}`, label: `Incident: ${state.incidents[u.incident].symptom}` }
  return undefined
}

export function sourceOf(state: Projection, src: MemoryVersion['source']) {
  if (src.task && state.tasks[src.task]) return { href: `/work/${src.task}`, label: state.tasks[src.task].title }
  if (src.incident && state.incidents[src.incident])
    return { href: `/work/${src.incident}`, label: `Incident: ${state.incidents[src.incident].symptom}` }
  return undefined
}

export function current(m: Memory) {
  return m.versions[m.versions.length - 1]
}

export function lastUse(skill: Skill) {
  return skill.uses[skill.uses.length - 1]
}

export const memoryKind: Record<Memory['kind'], string> = {
  fact: 'Fact',
  preference: 'Your preference',
  procedure: 'Procedure',
}

export function Rev({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <code className={cn('rounded bg-secondary px-1.5 py-0.5 font-mono text-xs text-foreground', className)}>{children}</code>
  )
}

export function Meta({ rows }: { rows: [string, React.ReactNode][] }) {
  return (
    <dl className="grid grid-cols-[6.5rem_1fr] gap-x-3 gap-y-1.5 text-sm">
      {rows.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="text-muted-foreground">{k}</dt>
          <dd className="min-w-0 text-pretty break-words">{v}</dd>
        </div>
      ))}
    </dl>
  )
}

export function RowLink({
  href,
  icon,
  kicker,
  title,
  detail,
}: {
  href: string
  icon: React.ReactNode
  kicker: string
  title: React.ReactNode
  detail?: React.ReactNode
}) {
  return (
    <li>
      <Link href={href} className="flex min-h-14 items-center gap-3 px-4 py-3 hover:bg-secondary/60">
        <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-secondary text-muted-foreground" aria-hidden="true">
          {icon}
        </span>
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="text-xs text-muted-foreground">{kicker}</span>
          <span className="text-pretty break-words text-sm font-medium">{title}</span>
          {detail ? <span className="text-pretty text-xs leading-relaxed text-muted-foreground">{detail}</span> : null}
        </span>
        <ChevronRight className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
      </Link>
    </li>
  )
}
