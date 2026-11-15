import { useEffect, useRef, useState } from 'react';
import { Icon } from './icons';
import type { RuntimeOperation } from './types';

export function ExecutionRecovery({ orphanIds, operations, onResolve }: {
  orphanIds: string[];
  operations: RuntimeOperation[];
  onResolve: (id: string, body: { acknowledgeExternalEffects?: boolean }) => Promise<void>;
}) {
  const [inspected, setInspected] = useState<Record<string, boolean>>({});
  const [pendingId, setPendingId] = useState<string | null>(null);
  const actionPending = useRef(false);
  const mounted = useRef(true);
  const orphanKey = JSON.stringify(orphanIds);
  const running = operations.filter(operation => operation.status === 'running');
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    const current = new Set<string>(JSON.parse(orphanKey));
    setInspected(previous => Object.fromEntries(Object.entries(previous).filter(([id]) => current.has(id))));
  }, [orphanKey]);
  const reconcile = async (id: string, operation?: RuntimeOperation) => {
    if (actionPending.current || operation?.status === 'running' || operation?.requiresExternalInspection && !inspected[id]) return;
    actionPending.current = true; setPendingId(id);
    try { await onResolve(id, operation?.requiresExternalInspection ? { acknowledgeExternalEffects: true } : {}); }
    finally { actionPending.current = false; if (mounted.current) setPendingId(null); }
  };

  return <>
    {running.length > 0 && <div className="runtime-operations-notice" role="status"><Icon name="clock" size={16} /><div><strong>Runtime operation in progress</strong>{running.map(operation => <p key={operation.id}><code>{operation.method}</code><span>Running</span></p>)}<small>Queued tasks wait for runtime operations to finish.</small></div></div>}
    {orphanIds.length > 0 && <section className="orphan-warning execution-recovery" aria-label="Execution recovery"><strong>Orphan execution needs reconciliation</strong><p>The queue stays paused while execution is uncertain. Reconciliation checks the recorded local process groups and terminates verified helpers or confirms their absence. It does not repeat the interrupted operation.</p>
      {orphanIds.map(id => {
        const operation = operations.find(value => value.id === id);
        const external = operation?.requiresExternalInspection === true;
        return <article className="orphan-execution runtime-recovery-item" key={id} aria-label={`${operation?.method ?? 'Owned execution'} ${id}`}>
          <div className="orphan-identity"><strong>{operation?.method ?? 'Owned execution'}</strong><span>{operation?.status === 'running' ? 'Running' : 'Uncertain'}</span><code>{id}</code></div>
          {external && <><p>Inspect the external HTTP or systemd outcome before reconciling. The action may already have happened. Reconciliation will not retry it or stop an intended independent service.</p><label className="external-inspection"><input type="checkbox" checked={Boolean(inspected[id])} disabled={pendingId !== null} onChange={event => setInspected(previous => ({ ...previous, [id]: event.target.checked }))} /><span>I inspected the external effects</span></label></>}
          <button className="secondary-button danger" disabled={pendingId !== null || operation?.status === 'running' || external && !inspected[id]} aria-label={operation ? `Reconcile operation ${id}` : `Host inspected, resolve orphan ${id}`} onClick={() => void reconcile(id, operation)}>{pendingId === id ? 'Reconciling…' : operation ? 'Reconcile operation' : 'Host inspected · resolve orphan'}</button>
        </article>;
      })}
    </section>}
  </>;
}
