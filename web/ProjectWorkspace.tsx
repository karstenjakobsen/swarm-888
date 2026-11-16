import { useCallback, useEffect, useRef, useState } from 'react';
import type { ManagedExport } from '../src/managed/schemas';
import type { Project } from '../src/projects/schemas';
import { api, post } from './api';
import { Icon } from './icons';
import { connectionStatusLabel, managementError, shortCommit, type Connector } from './management';
import { ProjectEnvironment } from './ProjectEnvironment';

export function ProjectWorkspace({ project, workerConnected, onUpdated, onError, onDirtyChange, readOnly = false }: {
  project: Project; workerConnected: boolean; onUpdated: () => Promise<void>; onError: (message: string) => void; onDirtyChange?: (dirty: boolean) => void; readOnly?: boolean;
}) {
  const [snapshot, setSnapshot] = useState<ManagedExport | null>(null);
  const [files, setFiles] = useState<Record<string, string>>({});
  const [filename, setFilename] = useState('');
  const [newFilename, setNewFilename] = useState('');
  const [message, setMessage] = useState('');
  const [template, setTemplate] = useState('service');
  const [busy, setBusy] = useState('');
  const [loading, setLoading] = useState(false);
  const [logs, setLogs] = useState<string | null>(null);
  const [notice, setNotice] = useState('');
  const [now, setNow] = useState(Date.now);
  const generation = useRef(0);
  const lifetime = useRef(0);
  const actionPending = useRef(false);
  const metadataCommitAtLoad = useRef(project.source?.commit);
  const projectSource = useRef(project.source);
  projectSource.current = project.source;
  const base = `/projects/${encodeURIComponent(project.id)}`;
  const hasSource = Boolean(project.source);
  const source = snapshot?.source ?? project.source;
  const hasRunCommand = Boolean(snapshot?.manifest.run);
  const deploymentAge = now - Date.parse(project.deployment?.checkedAt ?? '');
  const deploymentFresh = workerConnected && deploymentAge >= 0 && deploymentAge < 60_000;
  const changedFiles = Object.fromEntries(Object.entries(files).filter(([name, text]) => snapshot?.files[name] !== text));
  const dirty = Object.keys(changedFiles).length > 0;
  const sourceChanged = Boolean(snapshot && project.source && project.source.commit !== snapshot.source.commit && project.source.commit !== metadataCommitAtLoad.current);
  const editorLocked = readOnly || loading || Boolean(busy) || !snapshot;
  useEffect(() => () => { lifetime.current++; }, []);
  useEffect(() => { onDirtyChange?.(dirty); return () => onDirtyChange?.(false); }, [dirty, onDirtyChange]);
  useEffect(() => {
    if (!dirty) return;
    const beforeUnload = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', beforeUnload);
    return () => window.removeEventListener('beforeunload', beforeUnload);
  }, [dirty]);
  useEffect(() => {
    const current = Date.now(); setNow(current);
    const remaining = Date.parse(project.deployment?.checkedAt ?? '') + 60_000 - current;
    if (!Number.isFinite(remaining) || remaining <= 0) return;
    const timeout = window.setTimeout(() => setNow(Date.now()), remaining + 1);
    return () => window.clearTimeout(timeout);
  }, [project.deployment?.checkedAt]);

  const acceptSnapshot = useCallback((value: ManagedExport, metadataCommit: string | null | undefined) => {
    metadataCommitAtLoad.current = metadataCommit;
    setSnapshot(value); setFiles(value.files);
    setFilename(previous => Object.hasOwn(value.files, previous) ? previous : Object.keys(value.files).sort()[0] ?? '');
  }, []);
  const load = useCallback(async () => {
    const request = ++generation.current;
    const metadataCommit = projectSource.current?.commit;
    setLoading(true);
    try {
      const value = await api<ManagedExport>(`${base}/source`);
      if (request !== generation.current) return;
      acceptSnapshot(value, metadataCommit);
    } catch (error) { if (request === generation.current) onError(managementError(error)); }
    finally { if (request === generation.current) setLoading(false); }
  }, [acceptSnapshot, base, onError]);
  useEffect(() => { if (hasSource && !snapshot) void load(); return () => { generation.current++; }; }, [hasSource, load]);

  const action = async (name: string, operation: () => Promise<unknown>, success: string, reloadSource = false) => {
    if (actionPending.current) return;
    actionPending.current = true;
    setBusy(name); setNotice('');
    const request = lifetime.current;
    const metadataCommit = projectSource.current?.commit;
    try {
      const value = await operation();
      if (request !== lifetime.current) return;
      if (name === 'save' || name === 'attach') acceptSnapshot(value as ManagedExport, metadataCommit);
      else if (reloadSource) await load();
      if (request !== lifetime.current) return;
      await onUpdated();
      if (request === lifetime.current) { setNotice(success); if (['save', 'attach', 'commit'].includes(name)) setMessage(''); }
    } catch (error) { if (request === lifetime.current) onError(managementError(error)); }
    finally { actionPending.current = false; if (request === lifetime.current) setBusy(''); }
  };
  const addFile = () => {
    const name = newFilename.trim();
    if (editorLocked || !name || Object.hasOwn(files, name)) return;
    if (name.startsWith('/') || name.split('/').some(part => !part || part === '.' || part === '..') || name.includes('\\')) { onError('Use a relative file path inside this source package.'); return; }
    setFiles(previous => ({ ...previous, [name]: '' })); setFilename(name); setNewFilename('');
  };
  const showLogs = async () => {
    if (actionPending.current) return;
    actionPending.current = true;
    setBusy('logs');
    const request = lifetime.current;
    try {
      const value = await api<{ text: string }>(`${base}/deployment/logs`);
      if (request === lifetime.current) setLogs(value.text || 'No recent logs.');
    } catch (error) { if (request === lifetime.current) onError(managementError(error)); }
    finally { actionPending.current = false; if (request === lifetime.current) setBusy(''); }
  };

  return <section className="project-workspace" aria-label="Source and deployment">
    <div className="project-section-heading"><h3><Icon name="code" size={15} />Source &amp; deployment</h3>{source && <span className="source-branch">{source.branch}</span>}</div>
    {!hasSource ? <div className="source-empty"><p>Keep editable source and its commit history with this project.</p><div className="source-actions"><label className="sr-only" htmlFor="source-template">Source template</label><select id="source-template" value={template} onChange={event => setTemplate(event.target.value)}><option value="service">Node service</option><option value="empty">Empty package</option></select><button className="secondary-button" disabled={Boolean(busy)} onClick={() => void action('attach', () => post(`${base}/source`, { template }), 'Source package added.')}><Icon name="plus" size={13} />{busy === 'attach' ? 'Adding source…' : 'Add source'}</button></div></div> : <>
      <div className="commit-comparison"><div><span>Source commit</span><code title={source?.commit ?? ''}>{shortCommit(source?.commit)}</code><small>{source?.dirty ? 'Workspace changes need a commit' : 'Committed source'}</small></div><div><span>Deployed commit</span><code title={project.deployment?.commit}>{project.deployment ? shortCommit(project.deployment.commit) : 'Not deployed'}</code><small>{project.deployment ? `${deploymentFresh ? '' : 'Last observed: '}${project.deployment.status}` : 'No release deployed'}</small></div></div>
      {sourceChanged && <p className="management-warning" role="status">Source changed elsewhere. Refresh files before saving or deploying. Your local edits remain in this editor.</p>}
      <details className="source-details" open><summary><Icon name="code" size={14} />Edit source<span>{dirty ? `${Object.keys(changedFiles).length} changed` : loading ? 'Loading…' : `${Object.keys(files).length} files`}</span><Icon name="chevron" size={12} /></summary>
        <div className="source-editor-toolbar"><label className="sr-only" htmlFor="source-file">Source file</label><select id="source-file" value={filename} onChange={event => setFilename(event.target.value)} disabled={editorLocked}>{Object.keys(files).sort().map(name => <option value={name} key={name}>{name}</option>)}</select><button className="subtle-button" disabled={Boolean(busy) || loading} onClick={() => { if (!dirty || window.confirm('Discard unsaved source edits and load the latest files?')) void load(); }}><Icon name="refresh" size={13} />Refresh files</button></div>
        {filename ? <textarea className="source-code" aria-label="Source code" disabled={editorLocked} spellCheck={false} value={files[filename] ?? ''} onChange={event => { setNotice(''); setFiles(previous => ({ ...previous, [filename]: event.target.value })); }} rows={14} /> : <p className="small-note">Add a file to start this package.</p>}
        <div className="source-new-file"><input aria-label="New source file path" disabled={editorLocked} value={newFilename} onChange={event => setNewFilename(event.target.value)} placeholder="New file, e.g. src/helper.mjs" /><button className="secondary-button" disabled={editorLocked || !newFilename.trim() || Object.hasOwn(files, newFilename.trim())} onClick={addFile}><Icon name="plus" size={13} />Add file</button></div>
        <label htmlFor="source-message">Commit message</label><input id="source-message" disabled={editorLocked} value={message} onChange={event => setMessage(event.target.value)} placeholder="Describe your change (optional)" maxLength={300} />
        <div className="source-actions"><button className="primary-button" disabled={!dirty || editorLocked || sourceChanged} onClick={() => void action('save', () => api(`${base}/source`, { method: 'PUT', body: JSON.stringify({ files: changedFiles, expectedCommit: snapshot?.source.commit, ...(message.trim() ? { message: message.trim() } : {}) }) }), 'Source saved and committed.')}><Icon name="check" size={13} />{busy === 'save' ? 'Saving…' : 'Save & commit'}</button>{source?.dirty && <button className="secondary-button" disabled={dirty || editorLocked || sourceChanged} onClick={() => void action('commit', () => post(`${base}/source/commit`, message.trim() ? { message: message.trim() } : {}), 'Workspace changes committed.', true)}>Commit workspace changes</button>}<span className="small-note">{dirty ? 'Save your edits before deploying.' : 'Deployment uses the committed source.'}</span></div>
      </details>
      <div className="deployment-card"><div><strong>{project.deployment ? deploymentFresh ? `Release ${project.deployment.status}` : 'Release status unknown' : hasRunCommand ? 'Ready for a first deployment' : 'No service command'}</strong><p>{(project.deployment ? `${deploymentFresh ? '' : 'Last observation: '}${project.deployment.detail}` : '') || (hasRunCommand ? 'Deploy this source as a systemd service on your VPS.' : 'Add a run command in operator-package.json to deploy this package as a service.')}</p>{project.deployment && <><code>{project.deployment.unitName}</code><p className="small-note">Last checked: {new Date(project.deployment.checkedAt).toLocaleString()}</p></>}</div><div className="source-actions"><button className="primary-button" disabled={Boolean(busy) || loading || sourceChanged || dirty || Boolean(source?.dirty) || !source?.commit || !hasRunCommand || !workerConnected} onClick={() => void action('deploy', () => post(`${base}/deploy`), 'Deployment updated.')}><Icon name="arrow" size={13} />{busy === 'deploy' ? 'Deploying…' : 'Deploy committed source'}</button>{project.deployment && <><button className="secondary-button" disabled={Boolean(busy) || !workerConnected} onClick={() => void action('status', () => api(`${base}/deployment`), 'Deployment status refreshed.')}><Icon name="refresh" size={13} />Refresh deployment</button><button className="secondary-button" disabled={Boolean(busy) || !workerConnected} onClick={() => void showLogs()}><Icon name="terminal" size={13} />{busy === 'logs' ? 'Loading…' : 'Deployment logs'}</button><button className="secondary-button danger" disabled={Boolean(busy) || !workerConnected || project.deployment.status === 'stopped'} onClick={() => void action('stop', () => post(`${base}/deployment/stop`), 'Deployment stopped.')}><Icon name="stop" size={12} />Stop service</button></>}</div></div>
      <ProjectEnvironment key={project.id} projectId={project.id} disabled={readOnly || Boolean(busy)} />
      <details className="source-paths"><summary>Source locations</summary><dl className="project-component-facts"><dt>Repository</dt><dd><code>{source?.repositoryPath}</code></dd><dt>Package</dt><dd><code>{source?.path}</code></dd><dt>Workspace</dt><dd><code>{source?.workspacePath}</code></dd>{project.deployment && <><dt>Release</dt><dd><code>{project.deployment.releaseDirectory}</code></dd></>}</dl></details>
    </>}
    {notice && <p className="management-notice" role="status"><Icon name="check" size={13} />{notice}</p>}
    {logs !== null && <section className="project-logs" aria-label="Deployment logs"><header><h3>Deployment logs</h3><button className="icon-button" aria-label="Close deployment logs" onClick={() => setLogs(null)}><Icon name="close" size={14} /></button></header><pre>{logs}</pre></section>}
  </section>;
}

export function ProjectConnections({ project, onUpdated, onError }: { project: Project; onUpdated: () => Promise<void>; onError: (message: string) => void }) {
  const [connectors, setConnectors] = useState<Connector[]>([]);
  const [selected, setSelected] = useState<string[]>(project.connectorIds ?? []);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [changedElsewhere, setChangedElsewhere] = useState(false);
  const generation = useRef(0);
  const actionPending = useRef(false);
  const assignmentKey = JSON.stringify([...(project.connectorIds ?? [])].sort());
  const baseline = useRef(assignmentKey);
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  useEffect(() => {
    if (assignmentKey === baseline.current) return;
    const clean = JSON.stringify([...selectedRef.current].sort()) === baseline.current;
    baseline.current = assignmentKey;
    if (clean) setSelected(JSON.parse(assignmentKey) as string[]);
    setChangedElsewhere(!clean);
    setSaved(false);
  }, [assignmentKey]);
  useEffect(() => {
    const request = ++generation.current;
    void api<Connector[]>('/connectors').then(value => { if (request === generation.current) setConnectors(value); }).catch(error => { if (request === generation.current) onError(managementError(error)); }).finally(() => { if (request === generation.current) setLoading(false); });
    return () => { generation.current++; };
  }, [onError]);
  const save = async () => {
    if (actionPending.current) return;
    actionPending.current = true;
    setBusy(true); const request = generation.current;
    try {
      const value = await api<Project>(`/projects/${encodeURIComponent(project.id)}/connectors`, { method: 'PUT', body: JSON.stringify({ connectorIds: selected }) });
      if (request === generation.current) {
        const accepted = value.connectorIds ?? selected;
        baseline.current = JSON.stringify([...accepted].sort()); setSelected(accepted); setChangedElsewhere(false);
        await onUpdated();
        if (request === generation.current) setSaved(true);
      }
    } catch (error) { if (request === generation.current) onError(managementError(error)); }
    finally { actionPending.current = false; if (request === generation.current) setBusy(false); }
  };
  return <section className="project-connections" aria-label="Project connections"><div className="project-section-heading"><h3><Icon name="link" size={15} />Connections</h3></div><p className="small-note">Choose which registered tools the operator can use for this project.</p>{changedElsewhere && <div className="management-warning" role="status"><p>Saved connections changed elsewhere. Review your choices before saving.</p><button className="text-button" disabled={busy} onClick={() => { setSelected(JSON.parse(baseline.current) as string[]); setChangedElsewhere(false); setSaved(false); }}>Reload saved choices</button></div>}{loading ? <p className="small-note">Loading connections…</p> : connectors.length ? <><div className="connection-assignments">{connectors.map(connector => <label key={connector.id}><input type="checkbox" disabled={busy} checked={selected.includes(connector.id)} onChange={event => { setSaved(false); setSelected(previous => event.target.checked ? [...previous, connector.id] : previous.filter(id => id !== connector.id)); }} /><span><strong>{connector.name}</strong><small>{connector.enabled ? `${connector.tools.length} ${connector.tools.length === 1 ? 'tool' : 'tools'} · ${connectionStatusLabel[connector.status]}` : 'Disabled globally'}</small></span></label>)}</div><button className="secondary-button" disabled={busy} onClick={() => void save()}>{busy ? 'Saving…' : saved ? 'Connections saved' : 'Save connections'}</button></> : <p className="small-note">Register a connection in Connections, then assign it here.</p>}</section>;
}
