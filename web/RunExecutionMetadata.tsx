import type { Run } from './types';
import { TaskBudgetSummary } from './JobsPanel';

function usageCounters(value: unknown): { input?: number; output?: number; total?: number } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  let data = value as Record<string, unknown>;
  if (data.tokenUsage && typeof data.tokenUsage === 'object') data = data.tokenUsage as Record<string, unknown>;
  if (data.total && typeof data.total === 'object') data = data.total as Record<string, unknown>;
  const numeric = (...values: unknown[]) => values.find(value => typeof value === 'number' && Number.isFinite(value) && value >= 0) as number | undefined;
  return { input: numeric(data.inputTokens, data.input_tokens), output: numeric(data.outputTokens, data.output_tokens), total: numeric(data.totalTokens, data.total_tokens, data.total) };
}

export function RunExecutionMetadata({ run, onOpenRun }: { run: Run; onOpenRun: (id: string) => Promise<void> }) {
  const usage = usageCounters(run.usage), knownUsage = Object.values(usage).some(value => value !== undefined);
  const raw = run.usage === undefined || run.usage === null ? '' : JSON.stringify(run.usage, null, 2);
  return <div className="run-execution-metadata"><div className="run-execution-tags"><span>{run.taskType || (run.kind === 'improvement' ? 'improvement' : 'interactive')}</span><span>{run.assignedWorkerId ? `Worker ${run.assignedWorkerId}` : run.workerId ? `Requested ${run.workerId}` : 'Awaiting assignment'}</span><span>{run.model || 'Model not captured'}{run.effort ? ` · ${run.effort}` : ''}</span>{run.requiredRoot && <span className="root-grant">Root granted</span>}{run.parentRunId && <button className="text-button" onClick={() => void onOpenRun(run.parentRunId!)}>Parent task {run.parentRunId.slice(0, 8)}</button>}</div>{run.blockedReason && <p className="management-warning" role="status">{run.blockedReason}</p>}<TaskBudgetSummary value={run} /><details className="run-usage"><summary>{knownUsage ? [usage.input !== undefined ? `${usage.input.toLocaleString()} input` : '', usage.output !== undefined ? `${usage.output.toLocaleString()} output` : '', usage.total !== undefined ? `${usage.total.toLocaleString()} total tokens` : ''].filter(Boolean).join(' · ') : 'Usage not reported'}</summary>{raw && <><pre>{raw.slice(0, 8000)}</pre>{raw.length > 8000 && <p className="small-note">Showing the first 8,000 characters.</p>}</>}</details></div>;
}
