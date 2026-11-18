import { useEffect, useRef, useState } from 'react';
import { api, post } from './api';
import { Icon } from './icons';
import { managementError, shortCommit } from './management';
import type { PackageKind, PackageRecord, RepositoryRecord, PackageDiscovery, PackageImport } from '../src/packages/schemas';

type SavedPackage = PackageRecord & { notice?: string };
const packageNames: Record<PackageKind, string> = { project: 'Project', connector: 'Connector', skill: 'Skill' };
const date = (value?: string | null) => value ? new Date(value).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : '—';

export function RepositoriesPanel({ onError, onProject }: { onError: (message: string) => void; onProject: (id: string) => void }) {
  const [repositories, setRepositories] = useState<RepositoryRecord[]>([]);
  const [packages, setPackages] = useState<PackageRecord[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [packageEditor, setPackageEditor] = useState<'create' | 'adopt' | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState('');
  const [notice, setNotice] = useState('');
  const [registrationNotice, setRegistrationNotice] = useState('');
  const [discovery, setDiscovery] = useState<PackageDiscovery | null>(null);
  const [fetchBranch, setFetchBranch] = useState('');
  const [selectedPaths, setSelectedPaths] = useState<string[]>([]);
  const [history, setHistory] = useState<{ packageId: string | null; attempts: PackageImport[] } | null>(null);
  const epoch = useRef(0);
  const loadGeneration = useRef(0);
  const mounted = useRef(true);
  const selected = repositories.find(repository => repository.id === selectedId);
  const repositoryPackages = packages.filter(item => item.repositoryId === selectedId);
  useEffect(() => { setFetchBranch(selected?.sourceBranch ?? ''); }, [selected?.id, selected?.sourceBranch]);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; epoch.current++; loadGeneration.current++; }; }, []);
  const load = async () => {
    const request = ++loadGeneration.current;
    const [repos, items] = await Promise.all([api<RepositoryRecord[]>('/repositories'), api<PackageRecord[]>('/packages')]);
    if (!mounted.current || request !== loadGeneration.current) return;
    setRepositories(repos); setPackages(items);
    setSelectedId(current => repos.some(repository => repository.id === current) ? current : repos[0]?.id ?? null);
  };
  useEffect(() => { void load().catch(cause => { if (mounted.current) onError(managementError(cause)); }).finally(() => { if (mounted.current) setLoading(false); }); }, []);
  const refreshAfterSave = (view: number) => {
    void load().catch(cause => {
      if (mounted.current && view === epoch.current) onError(`Changes saved. Could not refresh repository status. ${managementError(cause)}`);
    });
  };
  const choose = (id: string) => { epoch.current++; setSelectedId(id); setEditing(false); setPackageEditor(null); setDiscovery(null); setSelectedPaths([]); setHistory(null); setNotice(''); setRegistrationNotice(''); setBusy(''); };
  const discover = async (refresh = false) => {
    if (!selected || busy) return;
    const request = ++epoch.current; setBusy('discover'); setNotice(''); setRegistrationNotice(''); setDiscovery(null); setHistory(null);
    try {
      const url = `/repositories/${encodeURIComponent(selected.id)}/discover`;
      const value = refresh ? await post<PackageDiscovery>(url, { refresh: true, ...(fetchBranch.trim() ? { branch: fetchBranch.trim() } : {}) }) : await api<PackageDiscovery>(url);
      if (mounted.current && request === epoch.current) { setDiscovery(value); setSelectedPaths(value.packages.filter(item => item.manifest && !item.error).map(item => item.path)); }
    } catch (cause) { if (mounted.current && request === epoch.current) onError(managementError(cause)); }
    finally { if (mounted.current && request === epoch.current) setBusy(''); }
  };
  const importSelected = async () => {
    if (!selected || busy || !discovery || !selectedPaths.length) return;
    const request = ++epoch.current; setBusy('import');
    try {
      const result = await post<{ packages: PackageRecord[]; imports: PackageImport[]; registrations?: { packageId: string; notice?: string }[] }>(`/repositories/${encodeURIComponent(selected.id)}/import`, { paths: selectedPaths, expectedCommit: discovery.commit });
      if (!mounted.current) return;
      loadGeneration.current++;
      const updated = new Map(result.packages.map(item => [item.id, item]));
      setPackages(previous => [...previous.filter(item => !updated.has(item.id)), ...updated.values()]);
      const failures = result.imports?.filter(attempt => attempt.status === 'failed') ?? [];
      if (failures.length) throw new Error(failures.map(attempt => `${attempt.path}: ${attempt.error || 'Import failed'}`).join('\n'));
      refreshAfterSave(request);
      if (request === epoch.current) { setDiscovery(null); setSelectedPaths([]); setNotice('Selected packages imported. Importing records source metadata; validation and deployment are separate actions.'); setRegistrationNotice(result.registrations?.filter(item => item.notice).map(item => `${item.packageId}: ${item.notice}`).join('\n') || ''); }
    } catch (cause) { if (mounted.current && request === epoch.current) onError(managementError(cause)); }
    finally { if (mounted.current && request === epoch.current) setBusy(''); }
  };
  const showHistory = async (packageId: string | null) => {
    const request = ++epoch.current; setBusy(`history:${packageId}`); setHistory(null);
    try { const attempts = await api<PackageImport[]>(`/repositories/${encodeURIComponent(selectedId!)}/imports`); if (mounted.current && request === epoch.current) setHistory({ packageId, attempts: packageId ? attempts.filter(attempt => attempt.packageId === packageId) : attempts }); }
    catch (cause) { if (mounted.current && request === epoch.current) onError(managementError(cause)); }
    finally { if (mounted.current && request === epoch.current) setBusy(''); }
  };
  const acceptRepository = (repository: RepositoryRecord) => {
    loadGeneration.current++;
    setRepositories(previous => [...previous.filter(item => item.id !== repository.id), repository]);
    choose(repository.id);
    setNotice('Repository registered. Changes and commits stay on this machine.');
  };
  const acceptPackage = ({ notice: warning, ...item }: SavedPackage) => {
    loadGeneration.current++;
    setPackages(previous => [...previous.filter(existing => existing.id !== item.id), item]);
    setPackageEditor(null);
    setHistory(null);
    setNotice('Package registered and committed locally.');
    setRegistrationNotice(warning ?? '');
    // The commit is already durable. A failed status refresh must not reopen the save form.
    refreshAfterSave(epoch.current);
  };
  return <section className="resource-panel repositories-panel">
    <div className="page-heading"><div><div className="eyebrow">VERSIONED SOURCE</div><h1>Repositories</h1><p>Keep projects, connectors, and skills together in Git.</p></div><button className="primary-button" onClick={() => { epoch.current++; setEditing(true); setPackageEditor(null); setBusy(''); }}><Icon name="plus" size={15} />Add repository</button></div>
    <div className="projects-layout"><aside className="projects-list" aria-label="Repository list"><div className="list-count">{loading ? 'Loading repositories…' : `${repositories.length} ${repositories.length === 1 ? 'repository' : 'repositories'}`}</div>{repositories.map(repository => <button key={repository.id} aria-current={selectedId === repository.id && !editing ? 'true' : undefined} className={`project-list-item ${selectedId === repository.id && !editing ? 'selected' : ''}`} onClick={() => choose(repository.id)}><span className="project-list-icon"><Icon name="code" size={18} /></span><span className="project-list-copy"><strong>{repository.name}</strong><small>{repository.branch}</small></span><Icon name="chevron" size={13} /></button>)}{!loading && !repositories.length && <p className="project-list-empty">Add a remote URL to create a local repository or import existing packages.</p>}</aside>
      <div className="project-content">{editing ? <RepositoryEditor onCancel={() => setEditing(false)} onError={onError} onSave={acceptRepository} /> : selected ? <>
        <div className="project-detail-heading"><div><div className="eyebrow">GIT REPOSITORY</div><h2>{selected.name}</h2><p>{repositoryPackages.length} registered {repositoryPackages.length === 1 ? 'package' : 'packages'}</p></div><button className="subtle-button" disabled={Boolean(busy)} onClick={() => void load().catch(cause => onError(managementError(cause)))}><Icon name="refresh" size={14} />Refresh</button></div>
        <dl className="project-component-facts repository-facts"><dt>Remote</dt><dd><code>{selected.remoteUrl}</code></dd><dt>Working branch</dt><dd><code>{selected.branch}</code></dd><dt>Source branch</dt><dd><code>{selected.sourceBranch}</code></dd><dt>Local checkout</dt><dd><code>{selected.directory}</code></dd><dt>State</dt><dd>{selected.status === 'ready' ? 'Ready' : 'Needs attention'}</dd></dl>
        <p className="small-note">Commits are saved locally. Remote pushes are disabled.</p>{selected.error && <p className="management-warning" role="status">{selected.error}</p>}{selected.head && <p className="small-note repository-git-status"><code title={selected.head}>{shortCommit(selected.head)}</code> · {selected.hasRemoteBranch ? `${selected.ahead ?? 0} local commits · ${selected.behind ?? 0} behind` : 'No remote branch observed'}{selected.dirty ? ' · Uncommitted changes' : ''}</p>}
        <div><label htmlFor="repository-fetch-branch">Remote branch to fetch</label><input id="repository-fetch-branch" value={fetchBranch} disabled={Boolean(busy)} maxLength={200} placeholder={selected.sourceBranch} onChange={event => { setFetchBranch(event.target.value); setDiscovery(null); setSelectedPaths([]); }} /></div>
        <div className="connection-actions"><button className="primary-button" disabled={Boolean(busy)} onClick={() => void discover()}><Icon name="search" size={14} />{busy === 'discover' ? 'Discovering…' : 'Discover packages'}</button><button className="secondary-button" disabled={Boolean(busy)} onClick={() => void discover(true)}>Fetch &amp; preview remote</button><button className="secondary-button" disabled={Boolean(busy)} onClick={() => { setPackageEditor('create'); setDiscovery(null); }}>Create package</button><button className="secondary-button" disabled={Boolean(busy)} onClick={() => { setPackageEditor('adopt'); setDiscovery(null); }}>Adopt folder</button><button className="subtle-button" disabled={Boolean(busy)} onClick={() => void showHistory(null)}>Repository import history</button></div>
        {notice && <p className="management-notice" role="status">{notice}</p>}{registrationNotice && <p className="management-warning" role="status">{registrationNotice}</p>}{history?.packageId === null && <ImportHistory attempts={history.attempts} />}
        {packageEditor && <PackageEditor repository={selected} mode={packageEditor} onCancel={() => setPackageEditor(null)} onError={onError} onSave={acceptPackage} />}
        {discovery && <section className="platform-section package-discovery" aria-label="Discovered packages"><div className="project-detail-heading"><div><h3>Import preview</h3><p>{discovery.remoteBranch && <>Branch <code>{discovery.remoteBranch}</code> · </>}Revision <code>{shortCommit(discovery.commit)}</code>. Discovery reads manifests without running package commands.</p></div></div>{discovery.errors.map((error, index) => <p className="management-warning" key={index}>{error}</p>)}{discovery.packages.length ? <><div className="package-candidates">{discovery.packages.map(candidate => <label key={candidate.path} className={`package-candidate ${candidate.error ? 'invalid' : ''}`}><input type="checkbox" aria-label={`Import ${candidate.manifest?.name || candidate.path}`} checked={selectedPaths.includes(candidate.path)} disabled={!candidate.manifest || Boolean(candidate.error) || Boolean(busy)} onChange={event => setSelectedPaths(previous => event.target.checked ? [...previous, candidate.path] : previous.filter(path => path !== candidate.path))} /><span><strong>{candidate.manifest?.name || candidate.path}</strong><small>{candidate.manifest ? `${packageNames[candidate.manifest.kind]} · v${candidate.manifest.version} · ` : ''}<code>{candidate.path || '.'}</code></small>{candidate.manifest && <small><code>{candidate.manifest.id}</code>{candidate.imported ? ' · Already imported' : ''}</small>}{candidate.error && <span className="inline-error">{candidate.error}</span>}</span></label>)}</div><button className="primary-button" disabled={Boolean(busy) || !selectedPaths.length} onClick={() => void importSelected()}>{busy === 'import' ? 'Importing…' : `Import selected (${selectedPaths.length})`}</button></> : <p className="small-note">No operator-package.json manifests found. Use Adopt folder to identify existing code as a package.</p>}</section>}
        <section className="platform-section" aria-label="Registered packages"><h3>Packages</h3>{repositoryPackages.length ? <div className="repository-packages">{repositoryPackages.map(item => <article key={item.id} className="repository-package"><div className="project-component-heading"><span className="project-component-icon"><Icon name={item.kind === 'project' ? 'layers' : item.kind === 'skill' ? 'skill' : 'link'} size={17} /></span><div><div className="eyebrow">{packageNames[item.kind]}</div><h4>{item.name}</h4><p>v{item.version} · <code>{item.path || '.'}</code></p></div><span className="connection-status connected">Imported</span></div><dl className="project-component-facts"><dt>Package ID</dt><dd><code>{item.id}</code></dd><dt>Imported revision</dt><dd><code title={item.lastImportedCommit}>{shortCommit(item.lastImportedCommit)}</code></dd><dt>Imported at</dt><dd>{date(item.lastImportedAt)}</dd></dl><div className="connection-actions"><button className="subtle-button" disabled={Boolean(busy)} onClick={() => void showHistory(item.id)}>{busy === `history:${item.id}` ? 'Loading…' : 'Import history'}</button>{item.kind === 'project' && <button className="subtle-button" onClick={() => onProject(item.id)}>Open project<Icon name="chevron" size={12} /></button>}</div>{history?.packageId === item.id && <ImportHistory attempts={history.attempts} />}</article>)}</div> : <p className="small-note">Discover existing manifests or create the first package in this repository.</p>}</section>
      </> : <div className="project-welcome"><div className="resource-empty-icon"><Icon name="code" size={27} /></div><h2>A home for reusable code.</h2><p>Register one Git repository and keep each project, connector, or skill in its own folder with an operator-package.json manifest.</p><button className="primary-button" onClick={() => setEditing(true)}>Add your first repository</button></div>}</div>
    </div>
  </section>;
}

function RepositoryEditor({ onSave, onCancel, onError }: { onSave: (repository: RepositoryRecord) => void; onCancel: () => void; onError: (message: string) => void }) {
  const [name, setName] = useState('');
  const [remoteUrl, setRemoteUrl] = useState('');
  const [mode, setMode] = useState<'create' | 'clone'>('create');
  const [branch, setBranch] = useState('');
  const [saving, setSaving] = useState(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const save = async (event: React.FormEvent) => {
    event.preventDefault(); setSaving(true);
    try { const value = await post<RepositoryRecord>('/repositories', { name, remoteUrl, mode, ...(branch.trim() ? { branch: branch.trim() } : {}) }); if (mounted.current) onSave(value); }
    catch (cause) { if (mounted.current) onError(managementError(cause)); }
    finally { if (mounted.current) setSaving(false); }
  };
  return <form className="project-editor" onSubmit={save}><div className="project-detail-heading"><div><div className="eyebrow">GIT SOURCE</div><h2>Add a repository</h2></div><button type="button" className="icon-button" aria-label="Close repository editor" onClick={onCancel}><Icon name="close" size={16} /></button></div><fieldset className="plain-fieldset" disabled={saving}><label htmlFor="repository-name">Repository name</label><input id="repository-name" value={name} onChange={event => setName(event.target.value)} maxLength={120} required autoFocus /><label htmlFor="repository-remote">Remote URL</label><input id="repository-remote" value={remoteUrl} onChange={event => setRemoteUrl(event.target.value)} placeholder="git@github.com:owner/repository.git" required /><p className="small-note">Use an SSH or HTTPS URL without a password or token. The remote is recorded; nothing is pushed.</p><label htmlFor="repository-mode">Start with</label><select id="repository-mode" value={mode} onChange={event => setMode(event.target.value as 'create' | 'clone')}><option value="create">A new local repository</option><option value="clone">Clone an existing repository</option></select><label htmlFor="repository-branch">{mode === 'clone' ? 'Source branch (optional)' : 'Branch (optional)'}</label><input id="repository-branch" value={branch} onChange={event => setBranch(event.target.value)} placeholder={mode === 'clone' ? 'Remote default branch' : 'main'} /><div className="editor-actions"><button type="button" className="secondary-button" onClick={onCancel}>Cancel</button><button className="primary-button" disabled={saving || !name.trim() || !remoteUrl.trim()}>{saving ? mode === 'clone' ? 'Cloning…' : 'Creating…' : 'Register repository'}</button></div></fieldset></form>;
}

function PackageEditor({ repository, mode, onSave, onCancel, onError }: { repository: RepositoryRecord; mode: 'create' | 'adopt'; onSave: (value: SavedPackage) => void; onCancel: () => void; onError: (message: string) => void }) {
  const [kind, setKind] = useState<PackageKind>('project');
  const [name, setName] = useState('');
  const [path, setPath] = useState('');
  const [version, setVersion] = useState('0.1.0');
  const [description, setDescription] = useState('');
  const [template, setTemplate] = useState('service');
  const [transport, setTransport] = useState<'stdio' | 'http'>('stdio');
  const [command, setCommand] = useState('node');
  const [args, setArgs] = useState('server.mjs');
  const [url, setUrl] = useState('');
  const [runCommand, setRunCommand] = useState('');
  const [runArgs, setRunArgs] = useState('');
  const [saving, setSaving] = useState(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const save = async (event: React.FormEvent) => {
    event.preventDefault(); setSaving(true);
    try { const result = await post<SavedPackage>(`/repositories/${encodeURIComponent(repository.id)}/packages`, { kind, name, path: path.trim() || '.', version, description, adopt: mode === 'adopt', template: mode === 'adopt' ? 'empty' : kind === 'project' ? template : kind === 'connector' ? 'connector' : 'empty', ...(mode === 'adopt' && kind === 'connector' ? { mcp: transport === 'stdio' ? { transport, command, args: args.split('\n').filter(Boolean) } : { transport, url } } : {}), ...(mode === 'adopt' && kind === 'project' && runCommand.trim() ? { run: { command: runCommand.trim(), args: runArgs.split('\n').filter(Boolean) } } : {}) }); if (mounted.current) onSave(result); }
    catch (cause) { if (mounted.current) onError(managementError(cause)); }
    finally { if (mounted.current) setSaving(false); }
  };
  return <form className="project-editor repository-package-editor" onSubmit={save}><div className="project-detail-heading"><div><div className="eyebrow">V1 PACKAGE MANIFEST</div><h2>{mode === 'adopt' ? 'Adopt a folder' : 'Create a package'}</h2></div><button type="button" className="icon-button" aria-label="Close package editor" onClick={onCancel}><Icon name="close" size={16} /></button></div><fieldset className="plain-fieldset" disabled={saving}><div className="form-row"><div><label htmlFor="package-kind">Package kind</label><select id="package-kind" value={kind} onChange={event => setKind(event.target.value as PackageKind)}><option value="project">Project</option><option value="connector">Connector</option><option value="skill">Skill</option></select></div><div><label htmlFor="package-version">Package version</label><input id="package-version" value={version} onChange={event => setVersion(event.target.value)} required placeholder="0.1.0" /></div></div><label htmlFor="package-name">Package name</label><input id="package-name" value={name} onChange={event => setName(event.target.value)} required maxLength={120} /><label htmlFor="package-path">Folder in repository</label><input id="package-path" value={path} onChange={event => setPath(event.target.value)} placeholder={kind === 'project' ? 'apps/my-project' : kind === 'connector' ? 'connectors/my-connector' : 'skills/my-skill'} required /><p className="small-note">Relative to this repository. Use <code>.</code> for its root. The canonical package ID is generated once and saved in operator-package.json.</p><label htmlFor="package-description">Description</label><textarea id="package-description" value={description} onChange={event => setDescription(event.target.value)} maxLength={4000} rows={3} />{mode === 'create' && kind === 'project' && <><label htmlFor="package-template">Project template</label><select id="package-template" value={template} onChange={event => setTemplate(event.target.value)}><option value="service">Node service</option><option value="empty">Empty package</option></select></>}{mode === 'adopt' && kind === 'connector' && <><label htmlFor="package-mcp-transport">MCP transport</label><select id="package-mcp-transport" value={transport} onChange={event => setTransport(event.target.value as 'stdio' | 'http')}><option value="stdio">Local process (stdio)</option><option value="http">HTTP MCP server</option></select>{transport === 'stdio' ? <><label htmlFor="package-mcp-command">MCP command</label><input id="package-mcp-command" value={command} onChange={event => setCommand(event.target.value)} required /><label htmlFor="package-mcp-args">MCP arguments (one per line)</label><textarea id="package-mcp-args" value={args} onChange={event => setArgs(event.target.value)} rows={3} /></> : <><label htmlFor="package-mcp-url">MCP server URL</label><input id="package-mcp-url" type="url" value={url} onChange={event => setUrl(event.target.value)} required placeholder="https://provider.example/mcp" /></>}</>}{mode === 'adopt' && kind === 'project' && <><label htmlFor="package-run-command">Run command (optional)</label><input id="package-run-command" value={runCommand} onChange={event => setRunCommand(event.target.value)} placeholder="node" /><label htmlFor="package-run-args">Run arguments (one per line)</label><textarea id="package-run-args" value={runArgs} onChange={event => setRunArgs(event.target.value)} rows={2} placeholder="dist/server.js" /></>}{mode === 'adopt' && <p className="small-note">Adds a manifest to existing code and imports its identity. No build, check, or start command is executed. Credentials are configured separately.</p>}<div className="editor-actions"><button type="button" className="secondary-button" onClick={onCancel}>Cancel</button><button className="primary-button" disabled={saving || !name.trim() || !path.trim() || !version.trim()}>{saving ? 'Saving…' : mode === 'adopt' ? 'Adopt folder' : 'Create package'}</button></div></fieldset></form>;
}

function ImportHistory({ attempts }: { attempts: PackageImport[] }) {
  return <div className="package-import-history" aria-label="Package import history"><h4>Import history</h4>{attempts.length ? attempts.map(attempt => <div key={attempt.id} className="package-import-attempt"><span className={`connection-status ${attempt.status === 'imported' ? 'connected' : attempt.status === 'failed' ? 'error' : ''}`}>{attempt.status}</span><span><strong>{attempt.packageVersion ? `v${attempt.packageVersion}` : 'Version unknown'} · <code>{shortCommit(attempt.commit)}</code></strong><small><code>{attempt.path || '.'}</code> · {date(attempt.finishedAt || attempt.createdAt)} · Schema {attempt.schemaVersion ?? 'unknown'}</small>{attempt.error && <p className="inline-error">{attempt.error}</p>}</span></div>) : <p className="small-note">No import attempts recorded.</p>}</div>;
}
