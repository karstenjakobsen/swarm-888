import { useCallback, useEffect, useRef, useState } from 'react';
import type { ComponentInput, ComponentKind, Project, ProjectComponent, ProjectStatus } from '../src/projects/schemas';
import type { Conversation } from './types';
import { api, post } from './api';
import { Icon, type IconName } from './icons';
import { ProjectConnections, ProjectWorkspace } from './ProjectWorkspace';
import { ProjectWorker } from './ProjectWorker';
import { RepositoryFields } from './RepositoryFields';
import type { WorkerStatus } from '../src/workers/schemas';

const kindNames: Record<ComponentKind, string> = { website: 'Website', service: 'Background service', scheduled_job: 'Scheduled job', script: 'Manual script' };
const kindIcons: Record<ComponentKind, IconName> = { website: 'globe', service: 'terminal', scheduled_job: 'clock', script: 'code' };
const statusNames: Record<ProjectStatus, string> = { healthy: 'Healthy', running: 'Running', scheduled: 'Scheduled', ready: 'Ready', stopped: 'Stopped', failed: 'Failed', unknown: 'Unknown' };
const timestamp = (value: string | null | undefined) => value && !Number.isNaN(new Date(value).getTime()) ? new Date(value).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : 'Not observed';
const errorMessage = (error: unknown) => error instanceof Error ? error.message : 'Could not update the project.';

function StatusBadge({ status }: { status: ProjectStatus }) {
  return <span className={`project-status ${status}`}><span className="status-dot" />{statusNames[status]}</span>;
}

export function ProjectsPanel({ workerConnected, onError, onConversation, onSelectConversation, initialProjectId, onBeforeNavigate, onUnsavedSourceChange, navigationPending, workers = [] }: {
  workerConnected: boolean;
  onError: (message: string) => void;
  onConversation: (conversation: Conversation) => void;
  onSelectConversation: (id: string) => void;
  initialProjectId?: string | null;
  onBeforeNavigate: () => boolean;
  onUnsavedSourceChange: (dirty: boolean) => void;
  navigationPending: boolean;
  workers?: WorkerStatus[];
}) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(initialProjectId ?? null);
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(true);
  const [editor, setEditor] = useState<'create' | 'edit' | null>(null);
  const [componentEditor, setComponentEditor] = useState<ProjectComponent | 'new' | null>(null);
  const [busy, setBusy] = useState(false);
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [logs, setLogs] = useState<{ componentId: string; name: string; text: string; truncated: boolean; checkedAt: string } | null>(null);
  const [logsBusy, setLogsBusy] = useState<string | null>(null);
  const generation = useRef(0);
  const logsGeneration = useRef(0);
  const removing = useRef(false);
  const mounted = useRef(true);
  const currentProjects = useRef(projects);
  currentProjects.current = projects;
  const selection = useRef(selectedId);
  selection.current = selectedId;
  const selected = projects.find(project => project.id === selectedId);

  const load = useCallback(async () => {
    if (removing.current) return;
    const request = ++generation.current;
    try {
      const value = await api<Project[]>('/projects');
      if (request !== generation.current) return;
      setProjects(value);
      setSelectedId(previous => value.some(project => project.id === previous) ? previous : value[0]?.id ?? null);
    } catch (error) { if (request === generation.current) onError(errorMessage(error)); }
    finally { if (request === generation.current) setLoading(false); }
  }, [onError]);
  useEffect(() => {
    void load();
    const interval = window.setInterval(() => { void load(); }, 15_000);
    return () => { generation.current++; window.clearInterval(interval); };
  }, [load, workerConnected]);
  useEffect(() => { logsGeneration.current++; setLogs(null); setLogsBusy(null); setComponentEditor(null); }, [selectedId]);
  useEffect(() => () => { logsGeneration.current++; }, []);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  const choose = (id: string) => { if (removing.current || (id !== selectedId || editor) && !onBeforeNavigate()) return; selection.current = id; setSelectedId(id); setEditor(null); };
  const saveProject = (value: Project) => {
    generation.current++;
    setProjects(previous => previous.some(project => project.id === value.id) ? previous.map(project => project.id === value.id ? value : project) : [value, ...previous]);
    choose(value.id);
  };
  const refresh = async () => {
    if (!selected || busy) return;
    const id = selected.id;
    setBusy(true);
    try {
      const value = await post<Project>(`/projects/${encodeURIComponent(id)}/refresh`);
      setProjects(previous => previous.map(project => project.id === id ? value : project));
    } catch (error) { onError(errorMessage(error)); }
    finally { setBusy(false); }
  };
  const ask = async () => {
    if (!selected || busy || !onBeforeNavigate()) return;
    setBusy(true);
    try { onConversation(await post<Conversation>(`/projects/${encodeURIComponent(selected.id)}/conversations`)); }
    catch (error) { onError(errorMessage(error)); }
    finally { setBusy(false); }
  };
  const removeProject = async () => {
    if (!selected || busy || navigationPending || removing.current || !onBeforeNavigate()) return;
    const project = selected;
    if (!window.confirm(`Remove "${project.name}" from Projects?\n\nDirectory: ${project.directory}\n\nThis removes the project registration, its metadata, and project-owned connection registrations. Their assignments to other projects are also removed. Source and runtime files, Git history, and conversations are kept. Existing services keep running.`)) return;
    removing.current = true; generation.current++; logsGeneration.current++;
    setRemovingId(project.id); setBusy(true);
    try {
      const result = await api<{ ok: true }>(`/projects/${encodeURIComponent(project.id)}`, { method: 'DELETE' });
      if (!mounted.current) return;
      if (result?.ok !== true) throw new Error('Could not confirm removal of the project registration. Refresh Projects before trying again.');
      generation.current++;
      const remaining = currentProjects.current.filter(value => value.id !== project.id);
      setProjects(remaining);
      if (selection.current === project.id) { selection.current = remaining[0]?.id ?? null; setSelectedId(selection.current); }
      setEditor(null); setComponentEditor(null); setLogs(null); setLogsBusy(null);
      removing.current = false;
      await load();
    } catch (error) { if (mounted.current) onError(errorMessage(error)); }
    finally { removing.current = false; if (mounted.current) { setRemovingId(null); setBusy(false); } }
  };
  const showLogs = async (component: ProjectComponent) => {
    const projectId = selectedId;
    if (!projectId) return;
    const request = ++logsGeneration.current;
    setLogsBusy(component.id);
    try {
      const value = await api<{ text: string; truncated: boolean; checkedAt: string }>(`/projects/${encodeURIComponent(projectId)}/components/${encodeURIComponent(component.id)}/logs`);
      if (selection.current === projectId && request === logsGeneration.current) setLogs({ ...value, componentId: component.id, name: component.name });
    } catch (error) { if (selection.current === projectId && request === logsGeneration.current) onError(errorMessage(error)); }
    finally { if (selection.current === projectId && request === logsGeneration.current) setLogsBusy(null); }
  };
  const filtered = projects.filter(project => `${project.name} ${project.description}`.toLowerCase().includes(query.toLowerCase()));

  return <section className="resource-panel projects-panel">
    <div className="page-heading"><div><div className="eyebrow">WHAT YOU'RE BUILDING</div><h1>Projects</h1><p>Your websites, services, and automations. Beyond the conversation.</p></div><button className="primary-button" disabled={removingId !== null || navigationPending} onClick={() => { if (onBeforeNavigate()) { setEditor('create'); setComponentEditor(null); } }}><Icon name="plus" size={15} />Create project</button></div>
    {!workerConnected && <div className="project-connection-note" role="status"><Icon name="clock" size={16} /><span><strong>Live status is unknown</strong>The worker is unavailable. Saved projects and previous observations remain here.</span></div>}
    <div className="projects-layout">
      <aside className="projects-list" aria-label="Project list">
        <label className="search-field"><Icon name="search" size={16} /><input aria-label="Search projects" disabled={removingId !== null} value={query} onChange={event => setQuery(event.target.value)} placeholder="Find a project…" /></label>
        <div className="list-count">{loading ? 'Loading projects…' : `${projects.length} ${projects.length === 1 ? 'project' : 'projects'}`}</div>
        {filtered.map(project => <button className={`project-list-item ${project.id === selectedId && editor !== 'create' ? 'selected' : ''}`} key={project.id} disabled={removingId !== null} onClick={() => choose(project.id)}><span className="project-list-icon"><Icon name="layers" size={18} /></span><span className="project-list-copy"><strong>{project.name}</strong><small>{project.components.length} {project.components.length === 1 ? 'component' : 'components'}</small></span><StatusBadge status={workerConnected ? project.status : 'unknown'} /></button>)}
        {!loading && filtered.length === 0 && <p className="project-list-empty">{query ? 'No projects match your search.' : 'Projects you create or register will appear here.'}</p>}
      </aside>
      <div className="project-content">
        {editor ? <ProjectEditor key={editor === 'edit' ? selected?.id : 'new'} project={editor === 'edit' ? selected : undefined} onCancel={() => setEditor(null)} onSave={saveProject} onError={onError} /> : selected ? <fieldset disabled={removingId !== null} style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
          <div className="project-detail-heading"><div><div className="eyebrow">{selected.origin === 'adopted' ? 'REGISTERED PROJECT' : 'PROJECT'}</div><h2>{selected.name}</h2><p>{selected.description || 'Give your operator a goal to start building this project.'}</p><button className="subtle-button danger" disabled={busy || navigationPending} onClick={() => void removeProject()}><Icon name="close" size={13} />{removingId === selected.id ? 'Removing project…' : 'Remove project'}</button></div><button className="subtle-button" onClick={() => { if (onBeforeNavigate()) setEditor('edit'); }} aria-label="Edit project"><Icon name="settings" size={14} />Edit</button></div>
          <div className="project-overview"><StatusBadge status={workerConnected ? selected.status : 'unknown'} /><span>Last checked: {timestamp(selected.lastCheckedAt)}</span><button className="subtle-button" onClick={() => void refresh()} disabled={busy || !workerConnected}><Icon name="refresh" size={14} />{busy ? 'Working…' : 'Refresh status'}</button></div>
          <div className="project-actions"><button className="primary-button" onClick={() => void ask()} disabled={busy}><Icon name="chat" size={15} />Ask operator</button><span className="small-note">Start a conversation with this project's context.</span></div>
          <ProjectWorker key={`worker-${selected.id}`} project={selected} workers={workers} onUpdated={load} onError={onError} />
          <ProjectWorkspace readOnly={busy || navigationPending} key={`source-${selected.id}`} project={selected} workerConnected={workerConnected} onUpdated={load} onError={onError} onDirtyChange={onUnsavedSourceChange} />
          <ProjectConnections key={`connections-${selected.id}`} project={selected} onUpdated={load} onError={onError} />
          <div className="project-section-heading"><h3>Components <span>{selected.components.length}</span></h3><button className="secondary-button" onClick={() => setComponentEditor('new')}><Icon name="plus" size={13} />Add component</button></div>
          {componentEditor && <ComponentEditor key={typeof componentEditor === 'string' ? 'new' : componentEditor.id} projectId={selected.id} component={typeof componentEditor === 'string' ? undefined : componentEditor} onCancel={() => setComponentEditor(null)} onSave={async () => { logsGeneration.current++; setLogs(null); setLogsBusy(null); setComponentEditor(null); await load(); }} onError={onError} />}
          <div className="project-components">
            {selected.components.map(component => <article className="project-component" key={component.id}>
              <div className="project-component-heading"><span className={`project-component-icon ${component.kind}`}><Icon name={kindIcons[component.kind]} size={18} /></span><div><span className="eyebrow">{kindNames[component.kind]}</span><h4>{component.name}</h4></div><StatusBadge status={workerConnected ? component.status : 'unknown'} /></div>
              {component.observation ? <p className="project-component-detail">{!workerConnected || component.stale ? 'Last observation: ' : ''}{component.observation.detail}</p> : <p className="project-component-detail">Registered. Waiting for the worker to verify its state.</p>}
              <dl className="project-component-facts">
                {component.kind === 'scheduled_job' && <><dt>Scheduler</dt><dd>{component.unitName ? 'systemd timer' : 'Cron job'}</dd><dt>Schedule</dt><dd>{component.schedule || 'See timer configuration'}{component.timezone ? ` · ${component.timezone}` : ''}</dd><dt>Next run</dt><dd>{!workerConnected || component.stale ? 'Unknown' : !component.unitName && !component.observation?.nextRunAt ? 'Unavailable from cron' : timestamp(component.observation?.nextRunAt)}</dd><dt>Last run</dt><dd>{!component.unitName && !component.observation?.lastRunAt ? 'Unavailable from cron' : timestamp(component.observation?.lastRunAt)}{component.observation?.lastExitCode !== undefined && component.observation.lastExitCode !== null ? ` · Exit ${component.observation.lastExitCode}` : ''}</dd></>}
                {component.observation?.serviceState && <><dt>Service</dt><dd>{!workerConnected || component.stale ? 'Last observed: ' : ''}{component.observation.serviceState}</dd></>}
                {component.kind === 'website' && <><dt>Website check</dt><dd>{workerConnected && !component.stale ? component.observation?.healthStatus || 'Unknown' : 'Unknown'}</dd></>}
                {component.scriptPath && <><dt>Script</dt><dd><code>{component.scriptPath}</code></dd></>}
                <dt>Checked</dt><dd>{timestamp(component.observation?.checkedAt)}</dd>
              </dl>
              <div className="project-component-actions">{component.url && <a className="secondary-button" href={component.url} target="_blank" rel="noopener noreferrer"><Icon name="link" size={13} />Open website</a>}{component.unitName && <button className="secondary-button" disabled={!workerConnected || logsBusy === component.id} onClick={() => void showLogs(component)}><Icon name="terminal" size={13} />{logsBusy === component.id ? 'Loading logs…' : 'View logs'}</button>}<button className="subtle-button" aria-label={`Edit ${component.name}`} onClick={() => setComponentEditor(component)}>Edit</button></div>
            </article>)}
            {selected.components.length === 0 && !componentEditor && <div className="project-components-empty"><Icon name="layers" size={25} /><h4>Give your project a shape</h4><p>Add a website, background service, scheduled job, or script. Your operator can register them as it builds.</p></div>}
          </div>
          {logs && <section className="project-logs" aria-label={`Logs for ${logs.name}`}><header><h3>{logs.name} · logs</h3><button className="icon-button" aria-label="Close logs" onClick={() => { logsGeneration.current++; setLogs(null); setLogsBusy(null); }}><Icon name="close" size={14} /></button></header><pre>{logs.text || 'No recent logs.'}</pre><p className="small-note">Checked {timestamp(logs.checkedAt)}{logs.truncated ? ' · Showing recent output only' : ''}</p></section>}
          <details className="project-directory"><summary><Icon name="folder" size={14} />Project directory<Icon name="chevron" size={12} /></summary><code>{selected.directory}</code></details>
          {selected.runs?.length > 0 && <section className="project-task-history"><h3>Recent tasks</h3>{selected.runs.map(run => <button key={run.id} onClick={() => onSelectConversation(run.conversationId)}><Icon name="chat" size={14} /><span>{run.prompt}</span><small>{run.status}</small><Icon name="chevron" size={12} /></button>)}</section>}
        </fieldset> : <div className="project-welcome"><div className="resource-empty-icon"><Icon name="layers" size={27} /></div><span className="eyebrow">A HOME FOR YOUR WORK</span><h2>Built to keep running.</h2><p>Keep websites, services, schedules, and scripts together. Track what is on your VPS and return to it whenever you need.</p><button className="primary-button" onClick={() => setEditor('create')}><Icon name="plus" size={15} />Create your first project</button></div>}
      </div>
    </div>
  </section>;
}

function ProjectEditor({ project, onSave, onCancel, onError }: { project?: Project; onSave: (project: Project) => void; onCancel: () => void; onError: (message: string) => void }) {
  const [name, setName] = useState(project?.name || '');
  const [description, setDescription] = useState(project?.description || '');
  const [origin, setOrigin] = useState<'created' | 'adopted'>('created');
  const [directory, setDirectory] = useState('');
  const [sourceLocation, setSourceLocation] = useState({ repositoryId: '', packagePath: '' });
  const [template, setTemplate] = useState('service');
  const [saving, setSaving] = useState(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const save = async (event: React.FormEvent) => {
    event.preventDefault();setSaving(true);
    try {
      const value = project ? await api<Project>(`/projects/${encodeURIComponent(project.id)}`, { method: 'PATCH', body: JSON.stringify({ name, description }) }) : await post<Project>('/projects', { name, description, origin, ...sourceLocation, ...(origin === 'adopted' ? { directory } : { managed: true, template }) });
      if (mounted.current) onSave(value);
    } catch (error) { if (mounted.current) onError(errorMessage(error)); }
    finally { if (mounted.current) setSaving(false); }
  };
  return <form className="project-editor" onSubmit={save}><div className="project-detail-heading"><div><div className="eyebrow">{project ? 'PROJECT DETAILS' : 'SOMETHING NEW'}</div><h2>{project ? 'Edit project' : 'Create a project'}</h2></div><button className="icon-button" type="button" aria-label="Close project editor" onClick={onCancel}><Icon name="close" size={17} /></button></div><label htmlFor="project-name">Project name</label><input id="project-name" value={name} onChange={event => setName(event.target.value)} required maxLength={120} placeholder="My website" autoFocus /><label htmlFor="project-description">Description</label><textarea id="project-description" value={description} onChange={event => setDescription(event.target.value)} maxLength={4000} rows={3} placeholder="What are you building?" />{!project && <><label htmlFor="project-origin">Start with</label><select id="project-origin" value={origin} onChange={event => setOrigin(event.target.value as 'created' | 'adopted')}><option value="created">A new project directory</option><option value="adopted">An existing project directory</option></select>{origin === 'adopted' ? <><label htmlFor="project-directory">Existing directory</label><input id="project-directory" value={directory} onChange={event => setDirectory(event.target.value)} placeholder="Absolute path inside the projects directory" required /><p className="small-note">Register a directory within the configured projects area.</p></> : <div className="managed-project-options"><p className="small-note">Keep source history, edit files, and deploy committed releases from this workspace.</p><label htmlFor="project-template">Project template</label><select id="project-template" value={template} onChange={event => setTemplate(event.target.value)}><option value="service">Node service</option><option value="empty">Empty package</option></select><p className="small-note">A persistent runtime directory is assigned automatically.</p></div>}<RepositoryFields {...sourceLocation} onChange={setSourceLocation} onError={onError} disabled={saving} prefix="project" /></>}<div className="editor-actions"><button className="secondary-button" type="button" onClick={onCancel}>Cancel</button><button className="primary-button" disabled={saving || !name.trim() || !project && (!sourceLocation.repositoryId || !sourceLocation.packagePath.trim())}>{saving ? 'Saving…' : project ? 'Save project' : 'Create project'}</button></div></form>;
}

function ComponentEditor({ projectId, component, onSave, onCancel, onError }: { projectId: string; component?: ProjectComponent; onSave: () => Promise<void>; onCancel: () => void; onError: (message: string) => void }) {
  const [draft, setDraft] = useState({ name: component?.name || '', kind: component?.kind || 'website' as ComponentKind, url: component?.url || '', unitName: component?.unitName || '', scriptPath: component?.scriptPath || '', schedule: component?.schedule || '', timezone: component?.timezone || '' });
  const [scheduler, setScheduler] = useState<'timer' | 'cron'>(component?.kind === 'scheduled_job' && !component.unitName ? 'cron' : 'timer');
  const [saving, setSaving] = useState(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const set = (key: keyof typeof draft, value: string) => setDraft(previous => ({ ...previous, [key]: value }));
  const cronJob = draft.kind === 'scheduled_job' && scheduler === 'cron';
  const save = async (event: React.FormEvent) => {
    event.preventDefault();setSaving(true);
    const body: ComponentInput = { name: draft.name, kind: draft.kind, unitName: draft.kind === 'script' || cronJob ? null : draft.unitName || null, url: draft.kind === 'website' ? draft.url : null, scriptPath: draft.kind === 'script' || cronJob ? draft.scriptPath : null, schedule: draft.kind === 'scheduled_job' ? draft.schedule || null : null, timezone: draft.kind === 'scheduled_job' ? draft.timezone || null : null };
    try {
      const base = `/projects/${encodeURIComponent(projectId)}/components`;
      if (component) await api(`${base}/${encodeURIComponent(component.id)}`, { method: 'PATCH', body: JSON.stringify(body) });
      else await post(base, body);
      if (mounted.current) await onSave();
    } catch (error) { if (mounted.current) onError(errorMessage(error)); }
    finally { if (mounted.current) setSaving(false); }
  };
  return <form className="project-component-editor" onSubmit={save}>
    <div className="project-section-heading"><h3>{component ? 'Edit component' : 'Add a component'}</h3><button className="icon-button" type="button" aria-label="Close component editor" onClick={onCancel}><Icon name="close" size={14} /></button></div>
    <div className="form-row"><div><label htmlFor="component-name">Component name</label><input id="component-name" value={draft.name} onChange={event => set('name', event.target.value)} required maxLength={120} placeholder="Public website" /></div><div><label htmlFor="component-kind">Type</label><select id="component-kind" value={draft.kind} onChange={event => set('kind', event.target.value)}>{Object.entries(kindNames).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></div></div>
    {draft.kind === 'scheduled_job' && <><label htmlFor="component-scheduler">Scheduler</label><select id="component-scheduler" value={scheduler} onChange={event => { setScheduler(event.target.value as 'timer' | 'cron'); set('schedule', ''); }}><option value="timer">systemd timer</option><option value="cron">Cron job</option></select></>}
    {draft.kind === 'website' && <><label htmlFor="component-url">Website URL</label><input id="component-url" type="url" value={draft.url} onChange={event => set('url', event.target.value)} placeholder="https://example.com" required /></>}
    {draft.kind !== 'script' && !cronJob && <><label htmlFor="component-unit">{draft.kind === 'scheduled_job' ? 'Timer unit' : draft.kind === 'website' ? 'Service unit (optional)' : 'Service unit'}</label><input id="component-unit" value={draft.unitName} onChange={event => set('unitName', event.target.value)} placeholder={draft.kind === 'scheduled_job' ? 'my-project-backup.timer' : 'my-project-web.service'} required={draft.kind !== 'website'} /><p className="small-note">Register an existing project component. This does not install or start a service.</p></>}
    {(draft.kind === 'script' || cronJob) && <><label htmlFor="component-script">Script path</label><input id="component-script" value={draft.scriptPath} onChange={event => set('scriptPath', event.target.value)} placeholder="scripts/report.mjs" required /><p className="small-note">Relative to the project directory.</p></>}
    {draft.kind === 'scheduled_job' && <><div className="form-row"><div><label htmlFor="component-schedule">{cronJob ? 'Cron expression' : 'Schedule description'}</label><input id="component-schedule" value={draft.schedule} onChange={event => set('schedule', event.target.value)} placeholder={cronJob ? '0 2 * * *' : 'Daily at 02:00'} required={cronJob} /></div><div><label htmlFor="component-timezone">Timezone</label><input id="component-timezone" value={draft.timezone} onChange={event => set('timezone', event.target.value)} placeholder="Optional, e.g. Europe/Paris" /></div></div>{cronJob && <p className="small-note">Five fields: minute, hour, day, month, weekday. This registers an existing cron job. Execution history and the next run may be unavailable.</p>}</>}
    <div className="editor-actions"><button className="secondary-button" type="button" onClick={onCancel}>Cancel</button><button className="primary-button" disabled={saving || !draft.name.trim()}>{saving ? 'Saving…' : component ? 'Save component' : 'Add component'}</button></div>
  </form>;
}
