import { useEffect, useRef } from 'react';
import type { TaskOptions } from '../src/tasks/schemas';
import type { WorkerStatus } from '../src/workers/schemas';
import type { Connector } from './management';

export function TaskExecutionFields({ value, onChange, workers, connectors = [], disabled = false, compact = false }: {
  value: TaskOptions; onChange: (value: TaskOptions) => void; workers: WorkerStatus[]; connectors?: Connector[]; disabled?: boolean; compact?: boolean;
}) {
  const selected = workers.find(status => status.worker.id === value.workerId);
  const constraints = useRef<HTMLDetailsElement>(null);
  useEffect(() => { if (value.requiredRoot && constraints.current) constraints.current.open = true; }, [value.requiredRoot]);
  const chooseWorker = (id: string) => {
    const worker = workers.find(status => status.worker.id === id)?.worker;
    onChange({ ...value, workerId: id || null, ...(worker ? { requiredRoot: worker.mode === 'root' } : {}) });
  };
  const budgets = [
    ['timeoutMs', 'Time limit (seconds)', 1, 86_400, 1000],
    ['maxToolCalls', 'Maximum tool calls', 1, 1000, 1],
    ['maxContextChars', 'Maximum context characters', 1000, 200_000, 1],
    ['maxOutputChars', 'Maximum output characters', 1000, 1_000_000, 1],
  ] as const;
  return <div className={`task-execution-fields ${compact ? 'compact' : ''}`}>
    <label>Worker<select aria-label="Task worker" value={value.workerId ?? ''} disabled={disabled} onChange={event => chooseWorker(event.target.value)}><option value="">Automatic · project default</option>{workers.map(({ worker }) => <option key={worker.id} value={worker.id}>{worker.name} · {worker.model || 'runtime default'} · {worker.mode}{worker.draining ? ' · draining' : !worker.enabled ? ' · disabled' : ''}</option>)}</select></label>
    {selected && <p className="small-note">{selected.connected ? selected.health?.runtime.authenticated ? 'Worker signed in' : 'Worker needs sign-in' : 'Worker offline'}{selected.worker.draining ? ' · new tasks wait while this worker drains' : ''}</p>}
    <details ref={constraints} className="task-constraints"><summary>Execution options</summary><label className="checkbox-label"><input type="checkbox" disabled={disabled} checked={value.requiredRoot ?? false} onChange={event => onChange({ ...value, requiredRoot: event.target.checked, ...(selected && (selected.worker.mode === 'root') !== event.target.checked ? { workerId: null } : {}) })} /><span>Requires root access</span></label><p className="small-note">User workers are the default. This grants root placement for this task.</p>
      <label>Connection access<select aria-label="Task connection scope" disabled={disabled} value={value.requiredConnectorIds === undefined ? 'project' : 'explicit'} onChange={event => onChange({ ...value, requiredConnectorIds: event.target.value === 'project' ? undefined : [] })}><option value="project">Inherit project connections</option><option value="explicit">Select connections for this task</option></select></label>{value.requiredConnectorIds === undefined ? <p className="small-note">Uses the connections assigned to the project.</p> : <fieldset className="connection-requirements"><legend>Selected connections</legend>{connectors.map(connector => <label className="checkbox-label" key={connector.id}><input type="checkbox" disabled={disabled} checked={value.requiredConnectorIds?.includes(connector.id) ?? false} onChange={event => onChange({ ...value, requiredConnectorIds: event.target.checked ? [...(value.requiredConnectorIds ?? []), connector.id] : (value.requiredConnectorIds ?? []).filter(id => id !== connector.id) })} /><span>{connector.name}{!connector.enabled ? ' · disabled' : connector.readiness?.ready === false ? ' · credential setup required' : ''}</span></label>)}{!value.requiredConnectorIds.length && <p className="small-note">None selected. This task receives no connection tools.</p>}</fieldset>}
      <div className="task-budget-grid">{budgets.map(([key, label, min, max, scale]) => <label key={key}>{label}<input aria-label={label} type="number" min={min} max={max} step={1} disabled={disabled} value={value[key] === undefined ? '' : value[key]! / scale} placeholder="Default" onChange={event => onChange({ ...value, [key]: event.target.value ? Number(event.target.value) * scale : undefined })} /></label>)}</div>
    </details>
  </div>;
}
