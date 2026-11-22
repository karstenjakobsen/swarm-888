import { AlertCircle, CircleDashed, CircleDot, CircleSlash, Hand, ShieldCheck, XCircle } from 'lucide-react'
import type { Outcome, OutcomeKey } from '@/lib/operator/project'
import { cn } from '@/lib/utils'

const styles: Record<OutcomeKey, { cls: string; Icon: typeof ShieldCheck }> = {
  verified: { cls: 'bg-verified/15 text-verified', Icon: ShieldCheck },
  resolved: { cls: 'bg-verified/15 text-verified', Icon: ShieldCheck },
  'needs-you': { cls: 'bg-attention text-attention-foreground', Icon: Hand },
  unverified: { cls: 'border border-dashed border-muted-foreground/60 text-muted-foreground', Icon: CircleDashed },
  working: { cls: 'bg-secondary text-foreground', Icon: CircleDot },
  mitigating: { cls: 'border border-attention/60 text-attention', Icon: CircleDot },
  investigating: { cls: 'bg-secondary text-foreground', Icon: AlertCircle },
  failed: { cls: 'bg-destructive/15 text-destructive', Icon: XCircle },
  unknown: { cls: 'border border-attention/60 text-attention', Icon: AlertCircle },
  stopped: { cls: 'bg-secondary text-muted-foreground', Icon: CircleSlash },
}

export function OutcomeChip({ outcome, size = 'sm', className }: { outcome: Outcome; size?: 'sm' | 'md'; className?: string }) {
  const { cls, Icon } = styles[outcome.key]
  const live = outcome.key === 'working' || outcome.key === 'mitigating'
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center gap-1.5 rounded-full font-medium',
        size === 'sm' ? 'h-6 px-2 text-xs' : 'h-8 px-3 text-sm',
        cls,
        className,
      )}
    >
      <Icon className={cn(size === 'sm' ? 'size-3.5' : 'size-4', live && 'animate-pulse')} aria-hidden="true" />
      {outcome.label}
    </span>
  )
}
