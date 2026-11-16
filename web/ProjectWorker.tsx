import { useEffect, useRef, useState } from 'react';
import type { Project } from '../src/projects/schemas';
import type { WorkerStatus } from '../src/workers/schemas';
import { api } from './api';
import { Icon } from './icons';
import { managementError } from './management';

export function ProjectWorker({ project, workers, onUpdated, onError }: { project: Project; workers: WorkerStatus[]; onUpdated: () => Promise<void>; onError: (message: string) => void }) {
  const [workerId, setWorkerId] = useState(project.defaultWorkerId ?? ''), [busy, setBusy] = useState(false), [saved, setSaved] = useState(false);
  const baseline = useRef(project.defaultWorkerId ?? ''), draft = useRef(workerId), mounted = useRef(true), pending = useRef(false); draft.current = workerId;
  useEffect(() => { const next = project.defaultWorkerId ?? ''; if (next === baseline.current) return; const clean = draft.current === baseline.current; baseline.current = next; if (clean) setWorkerId(next); setSaved(false); }, [project.defaultWorkerId]);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const save = async () => {
    if (pending.current) return; pending.current = true; setBusy(true);
    try { await api(`/projects/${encodeURIComponent(project.id)}`, { method: 'PATCH', body: JSON.stringify({ defaultWorkerId: workerId || null }) }); if (mounted.current) { baseline.current = workerId; await onUpdated(); if (mounted.current) setSaved(true); } }
    catch (error) { if (mounted.current) onError(managementError(error)); }
    finally { pending.current = false; if (mounted.current) setBusy(false); }
  };
  return <section className="project-worker" aria-label="Project default worker"><div className="project-section-heading"><h3><Icon name="terminal" size={15} />Default worker</h3></div><p className="small-note">Tasks in this project inherit this worker unless you choose another. Root workers still require an explicit task grant.</p><div className="source-actions"><label className="sr-only" htmlFor="project-worker">Project default worker</label><select id="project-worker" value={workerId} disabled={busy} onChange={event => { setWorkerId(event.target.value); setSaved(false); }}><option value="">Automatic user worker</option>{workerId && !workers.some(status => status.worker.id === workerId) && <option value={workerId}>{workerId} · unavailable</option>}{workers.map(({ worker }) => <option value={worker.id} key={worker.id}>{worker.name} · {worker.mode}{worker.draining ? ' · draining' : ''}</option>)}</select><button className="secondary-button" disabled={busy} onClick={() => void save()}>{busy ? 'Saving…' : saved ? 'Default worker saved' : 'Save default worker'}</button></div></section>;
}
