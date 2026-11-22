import { ChevronDown } from 'lucide-react'
import type { TrailItem } from '@/lib/operator/project'
import { clock } from '@/lib/operator/format'
import { cn } from '@/lib/utils'
import { Evidence } from './home-view'

type Group = { routine: true; items: TrailItem[] } | { routine: false; item: TrailItem }

function group(items: TrailItem[]): Group[] {
  const out: Group[] = []
  for (const item of items) {
    const last = out[out.length - 1]
    if (item.routine) {
      if (last?.routine) last.items.push(item)
      else out.push({ routine: true, items: [item] })
    } else out.push({ routine: false, item })
  }
  return out
}

export function EvidenceTrail({ items, outcomeSeq }: { items: TrailItem[]; outcomeSeq: number }) {
  return (
    <ol className="relative flex flex-col">
      {group(items).map((g) =>
        g.routine ? (
          <li key={`r-${g.items[0].seq}`} className="relative pl-8">
            <Rail />
            <details className="group py-2">
              <summary className="flex min-h-11 cursor-pointer items-center gap-2 text-sm text-muted-foreground">
                <span className="absolute left-[7px] top-[22px] size-2.5 rounded-full border border-border bg-background" aria-hidden="true" />
                {g.items.length} routine {g.items.length === 1 ? 'step' : 'steps'}
                <ChevronDown className="size-4 transition-transform group-open:rotate-180" aria-hidden="true" />
              </summary>
              <ol className="flex flex-col">
                {g.items.map((i) => (
                  <Row key={i.seq} item={i} highlight={i.seq === outcomeSeq} />
                ))}
              </ol>
            </details>
          </li>
        ) : (
          <li key={g.item.seq} className="relative pl-8">
            <Rail />
            <Row item={g.item} highlight={g.item.seq === outcomeSeq} dot />
          </li>
        ),
      )}
    </ol>
  )
}

function Rail() {
  return <span className="absolute bottom-0 left-[11px] top-0 w-px bg-border" aria-hidden="true" />
}

const dotTone = {
  good: 'border-verified bg-verified',
  bad: 'border-destructive bg-destructive',
  attention: 'border-attention bg-attention',
}

function Row({ item, highlight, dot }: { item: TrailItem; highlight: boolean; dot?: boolean }) {
  const hasEvidence = Boolean(item.command || item.output)
  const body = (
    <>
      <span className="flex items-baseline gap-2">
        <span className="font-mono text-[11px] text-muted-foreground">
          {clock(item.at)} · #{item.seq}
        </span>
        {item.kind === 'change' ? (
          <span className="rounded bg-secondary px-1.5 text-[11px] font-medium text-foreground">change</span>
        ) : null}
      </span>
      <span className={cn('text-pretty text-sm leading-snug', item.routine ? 'text-muted-foreground' : 'font-medium')}>
        {item.title}
      </span>
      {item.detail ? <span className="text-pretty text-sm leading-relaxed text-muted-foreground">{item.detail}</span> : null}
    </>
  )
  return (
    <div id={`e-${item.seq}`} className={cn('relative scroll-mt-24 py-2.5', highlight && 'rounded-lg')}>
      {dot ? (
        <span
          className={cn(
            'absolute -left-[25px] top-[15px] size-2.5 rounded-full border',
            item.tone ? dotTone[item.tone] : 'border-muted-foreground bg-background',
          )}
          aria-hidden="true"
        />
      ) : null}
      {highlight ? (
        <span className="mb-1 inline-block rounded-full bg-secondary px-2 py-0.5 text-[11px] font-medium text-foreground">
          The outcome is decided by this event
        </span>
      ) : null}
      {hasEvidence ? (
        <details className="group">
          <summary className="flex cursor-pointer flex-col gap-1">
            {body}
            <span className="flex min-h-8 items-center gap-1 text-xs text-muted-foreground">
              Evidence
              <ChevronDown className="size-3.5 transition-transform group-open:rotate-180" aria-hidden="true" />
            </span>
          </summary>
          <div className="pt-1">
            <Evidence command={item.command} output={item.output} />
          </div>
        </details>
      ) : (
        <div className="flex flex-col gap-1">{body}</div>
      )}
    </div>
  )
}
