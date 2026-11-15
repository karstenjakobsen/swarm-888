import { useCallback, useEffect, useRef, useState } from 'react';
import type { Project } from '../src/projects/schemas';
import { api, post } from './api';
import { Icon } from './icons';
import { connectionStatusLabel, managementError, shortCommit, type Connector } from './management';

export function ConnectionsPanel({ onError, onProject }: { onError: (message: string) => void; onProject: (id: string) => void }) {
  const [connectors, setConnectors] = useState<Connector[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editor, setEditor] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState('');
  const [toolName, setToolName] = useState('');
  const [argumentsText, setArgumentsText] = useState('{}');
  const [output, setOutput] = useState<{ text: string; isError: boolean } | null>(null);
  const [callError, setCallError] = useState('');
  const generation = useRef(0);
  const contextGeneration = useRef(0);
  const mounted = useRef(true);
  const actionPending = useRef(false);
  const currentId = useRef(selectedId);
  currentId.current = selectedId;
  const selected = connectors.find(connector => connector.id === selectedId);
  const selectedTool = selected?.tools.find(tool => tool.name === toolName);

  const load = useCallback(async () => {
    const request = ++generation.current;
    try {
      const value = await api<Connector[]>('/connectors');
      if (request !== generation.current) return;
      setConnectors(value);
      setSelectedId(previous => value.some(connector => connector.id === previous) ? previous : value[0]?.id ?? null);
    } catch (error) { if (request === generation.current) onError(managementError(error)); }
    finally { if (request === generation.current) setLoading(false); }
  }, [onError]);
  useEffect(() => { mounted.current = true; void load(); return () => { mounted.current = false; generation.current++; contextGeneration.current++; }; }, [load]);
  useEffect(() => { setToolName(selected?.tools[0]?.name ?? ''); setArgumentsText('{}'); setOutput(null); setCallError(''); }, [selectedId]);
  useEffect(() => { if (selected && !selected.tools.some(tool => tool.name === toolName)) setToolName(selected.tools[0]?.name ?? ''); }, [selected, toolName]);

  const accept = (connector: Connector, focus = true) => {
    generation.current++;
    setConnectors(previous => previous.some(value => value.id === connector.id) ? previous.map(value => value.id === connector.id ? connector : value) : [connector, ...previous]);
    if (focus) { currentId.current = connector.id; setSelectedId(connector.id); setEditor(false); }
  };
  const choose = (id: string) => {
    if (id === selectedId && !editor) return;
    contextGeneration.current++; currentId.current = id;
    setSelectedId(id); setEditor(false); setOutput(null); setCallError('');
  };
  const openEditor = () => { contextGeneration.current++; setEditor(true); };
  const argumentsChanged = (value: string) => {
    contextGeneration.current++; setArgumentsText(value); setOutput(null); setCallError('');
  };
  const createExample = async () => {
    if (actionPending.current) return;
    actionPending.current = true;
    const context = contextGeneration.current;
    setBusy('example');
    try { const value = await post<Connector>('/connectors/examples'); if (mounted.current) accept(value, context === contextGeneration.current); }
    catch (error) { if (mounted.current && context === contextGeneration.current) onError(managementError(error)); }
    finally { actionPending.current = false; if (mounted.current) setBusy(''); }
  };
  const update = async (kind: 'test' | 'enable') => {
    if (!selected || actionPending.current) return;
    actionPending.current = true;
    const id = selected.id;
    const context = contextGeneration.current;
    setBusy(kind); setCallError('');
    try {
      const value = kind === 'test' ? await post<Connector>(`/connectors/${encodeURIComponent(id)}/test`) : await api<Connector>(`/connectors/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify({ enabled: !selected.enabled }) });
      if (mounted.current) accept(value, context === contextGeneration.current && currentId.current === id);
    } catch (error) { if (mounted.current && context === contextGeneration.current) { onError(managementError(error)); if (kind === 'test') await load(); } }
    finally { actionPending.current = false; if (mounted.current) setBusy(''); }
  };
  const callTool = async () => {
    if (!selected || !toolName || actionPending.current) return;
    let args: unknown;
    try { args = JSON.parse(argumentsText); if (!args || Array.isArray(args) || typeof args !== 'object') throw new Error('Tool arguments must be a JSON object.'); }
    catch (error) { setCallError(error instanceof SyntaxError ? 'Enter valid JSON for the tool arguments.' : managementError(error)); return; }
    const id = selected.id;
    const context = contextGeneration.current;
    actionPending.current = true;
    setBusy('call'); setOutput(null); setCallError('');
    try {
      const result = await post<{ isError?: boolean }>(`/connectors/${encodeURIComponent(id)}/call`, { name: toolName, arguments: args });
      if (mounted.current && context === contextGeneration.current && currentId.current === id) setOutput({ text: JSON.stringify(result, null, 2), isError: result.isError === true });
    } catch (error) { if (mounted.current && context === contextGeneration.current && currentId.current === id) setCallError(managementError(error)); }
    finally { actionPending.current = false; if (mounted.current) setBusy(''); }
  };

  return <section className="resource-panel connections-panel">
    <div className="page-heading"><div><div className="eyebrow">TOOLS FOR YOUR OPERATOR</div><h1>Connections</h1><p>Connect MCP servers and give your projects the tools they need.</p></div><div className="management-heading-actions"><button className="secondary-button" disabled={Boolean(busy)} onClick={() => void createExample()}><Icon name="code" size={14} />{busy === 'example' ? 'Creating demo…' : 'Create local demo'}</button><button className="primary-button" onClick={openEditor}><Icon name="plus" size={14} />Add connection</button></div></div>
    <div className="projects-layout connections-layout"><aside className="projects-list" aria-label="Connection list"><div className="list-count">{loading ? 'Loading connections…' : `${connectors.length} ${connectors.length === 1 ? 'connection' : 'connections'}`}</div>{connectors.map(connector => <button key={connector.id} className={`project-list-item ${selectedId === connector.id && !editor ? 'selected' : ''}`} onClick={() => choose(connector.id)}><span className="project-list-icon"><Icon name="link" size={18} /></span><span className="project-list-copy"><strong>{connector.name}</strong><small>{connector.enabled ? `${connector.tools.length} ${connector.tools.length === 1 ? 'tool' : 'tools'}` : 'Disabled'}</small></span><span className={`connection-status ${connector.status}`}><span className="status-dot" />{connectionStatusLabel[connector.status]}</span></button>)}{!loading && connectors.length === 0 && <p className="project-list-empty">Start with the local demo or register an MCP server.</p>}</aside>
      <div className="project-content">{editor ? <ConnectionEditor onSave={accept} onCancel={() => setEditor(false)} onError={onError} /> : selected ? <>
        <div className="project-detail-heading"><div><div className="eyebrow">{selected.transport === 'stdio' ? 'LOCAL MCP SERVER' : 'HTTP MCP SERVER'}</div><h2>{selected.name}</h2><p>{selected.description || 'Tools available to your operator.'}</p></div><span className={`connection-status ${selected.status}`}><span className="status-dot" />{connectionStatusLabel[selected.status]}</span></div>
        <div className="connection-actions"><button className="primary-button" disabled={Boolean(busy) || !selected.enabled} onClick={() => void update('test')}><Icon name="refresh" size={14} />{busy === 'test' ? 'Testing…' : 'Test connection'}</button><button className="secondary-button" disabled={Boolean(busy)} onClick={() => void update('enable')}>{busy === 'enable' ? 'Saving…' : selected.enabled ? 'Disable connection' : 'Enable connection'}</button></div>
        {selected.projectId && <button className="subtle-button connection-source-link" onClick={() => onProject(selected.projectId!)}><Icon name="code" size={13} />Open source project<Icon name="chevron" size={12} /></button>}
        <p className="connection-detail" role="status">{!selected.enabled ? 'Disabled. This server is not available to the operator.' : selected.detail || 'Test this connection to discover its tools.'}</p>
        <dl className="project-component-facts connection-facts"><dt>Transport</dt><dd>{selected.transport}</dd>{selected.transport === 'stdio' && <><dt>Command</dt><dd><code>{[selected.command, ...(selected.args ?? [])].join(' ')}</code></dd></>}{selected.transport === 'stdio' && selected.cwd && <><dt>Directory</dt><dd><code>{selected.cwd}</code></dd></>}{selected.transport === 'http' && <><dt>URL</dt><dd><code>{selected.url}</code></dd></>}{selected.source && <><dt>Source commit</dt><dd><code title={selected.source.commit ?? ''}>{shortCommit(selected.source.commit)}</code></dd><dt>Source package</dt><dd><code>{selected.source.path}</code></dd></>}{selected.checkedAt && <><dt>Last tested</dt><dd>{new Date(selected.checkedAt).toLocaleString()}</dd></>}</dl>
        <section className="connection-tools" aria-label="Connection tools"><div className="project-section-heading"><h3>Tools <span>{selected.tools.length}</span></h3></div>{selected.tools.length ? <><label htmlFor="connection-tool">Tool to test</label><select id="connection-tool" value={toolName} onChange={event => { contextGeneration.current++; setToolName(event.target.value); setOutput(null); setCallError(''); }}>{selected.tools.map(tool => <option key={tool.name} value={tool.name}>{tool.name}</option>)}</select>{selectedTool?.description && <p className="small-note">{selectedTool.description}</p>}<details className="tool-schema"><summary>Input schema</summary><pre>{JSON.stringify(selectedTool?.inputSchema, null, 2)}</pre></details><label htmlFor="connection-arguments">Tool arguments (JSON)</label><textarea id="connection-arguments" spellCheck={false} rows={6} value={argumentsText} onChange={event => argumentsChanged(event.target.value)} />{callError && <p className="inline-error" role="alert">{callError}</p>}<button className="primary-button" disabled={Boolean(busy) || !selected.enabled || selected.status !== 'connected' || !toolName} onClick={() => void callTool()}><Icon name="arrow" size={13} />{busy === 'call' ? 'Running tool…' : 'Run tool'}</button>{output !== null && <div className={`tool-output ${output.isError ? 'is-error' : ''}`} role="region" aria-label="Tool result"><h4>{output.isError ? 'Tool reported an error' : 'Tool result'}</h4><pre>{output.text}</pre></div>}</> : <div className="connection-tools-empty"><Icon name="link" size={23} /><p>{selected.enabled ? 'Test the connection to discover available tools.' : 'Enable this connection, then test it to discover tools.'}</p></div>}</section>
        <p className="small-note connection-assignment-hint">Assign this connection in a project's Connections section to make its tools available there.</p>
      </> : <div className="project-welcome"><div className="resource-empty-icon"><Icon name="link" size={27} /></div><span className="eyebrow">EXTEND WHAT YOU CAN DO</span><h2>A connection to your tools.</h2><p>Register a local or HTTP MCP server. Try the local echo demo to verify discovery and a real tool call.</p><button className="primary-button" disabled={Boolean(busy)} onClick={() => void createExample()}><Icon name="code" size={14} />{busy === 'example' ? 'Creating demo…' : 'Create local demo'}</button></div>}</div>
    </div>
  </section>;
}

function ConnectionEditor({ onSave, onCancel, onError }: { onSave: (connector: Connector) => void; onCancel: () => void; onError: (message: string) => void }) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [draft, setDraft] = useState({ name: '', description: '', transport: 'stdio', command: '', args: '', cwd: '', url: '', projectId: '' });
  const [saving, setSaving] = useState(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; void api<Project[]>('/projects').then(value => { if (mounted.current) setProjects(value); }).catch(error => { if (mounted.current) onError(managementError(error)); }); return () => { mounted.current = false; }; }, [onError]);
  const set = (key: keyof typeof draft, value: string) => setDraft(previous => ({ ...previous, [key]: value }));
  const save = async (event: React.FormEvent) => {
    event.preventDefault(); setSaving(true);
    try {
      const value = await post<Connector>('/connectors', { name: draft.name, description: draft.description, transport: draft.transport, projectId: draft.projectId || null, enabled: true, ...(draft.transport === 'stdio' ? { command: draft.command, args: draft.args.split('\n').filter(value => value.length > 0), ...(draft.cwd.trim() ? { cwd: draft.cwd.trim() } : {}) } : { url: draft.url }) });
      if (mounted.current) onSave(value);
    } catch (error) { if (mounted.current) onError(managementError(error)); }
    finally { if (mounted.current) setSaving(false); }
  };
  return <form className="project-editor connection-editor" onSubmit={save}><div className="project-detail-heading"><div><div className="eyebrow">ANOTHER CAPABILITY</div><h2>Add a connection</h2></div><button className="icon-button" type="button" aria-label="Close connection editor" onClick={onCancel}><Icon name="close" size={17} /></button></div><label htmlFor="connector-name">Connection name</label><input id="connector-name" value={draft.name} onChange={event => set('name', event.target.value)} required maxLength={120} autoFocus placeholder="My local tools" /><label htmlFor="connector-description">Description</label><textarea id="connector-description" value={draft.description} onChange={event => set('description', event.target.value)} rows={2} maxLength={4000} /><label htmlFor="connector-transport">Transport</label><select id="connector-transport" value={draft.transport} onChange={event => set('transport', event.target.value)}><option value="stdio">Local process (stdio)</option><option value="http">HTTP MCP server</option></select>{draft.transport === 'stdio' ? <><label htmlFor="connector-command">Command</label><input id="connector-command" value={draft.command} onChange={event => set('command', event.target.value)} required placeholder="/usr/bin/node" /><label htmlFor="connector-args">Arguments (one per line)</label><textarea id="connector-args" value={draft.args} onChange={event => set('args', event.target.value)} rows={3} placeholder="/srv/projects/my-tools/server.mjs" /><label htmlFor="connector-cwd">Working directory (optional)</label><input id="connector-cwd" value={draft.cwd} onChange={event => set('cwd', event.target.value)} placeholder="/srv/projects/my-tools" /></> : <><label htmlFor="connector-url">MCP server URL</label><input id="connector-url" type="url" value={draft.url} onChange={event => set('url', event.target.value)} required placeholder="http://127.0.0.1:4000/mcp" /><p className="small-note">Use a server that does not require authentication. Credentials are not supported here yet.</p></>}<label htmlFor="connector-project">Related project (optional)</label><select id="connector-project" value={draft.projectId} onChange={event => set('projectId', event.target.value)}><option value="">No related project</option>{projects.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}</select><div className="editor-actions"><button className="secondary-button" type="button" onClick={onCancel}>Cancel</button><button className="primary-button" disabled={saving || !draft.name.trim()}>{saving ? 'Saving…' : 'Add connection'}</button></div></form>;
}
