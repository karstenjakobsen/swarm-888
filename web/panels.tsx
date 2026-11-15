import { useEffect, useRef, useState } from 'react';
import { api, asList, post } from './api';
import { Icon } from './icons';
import type { JsonObject } from './types';

type PanelProps = { onError: (message: string) => void };
const dateLabel = (value: string | null | undefined) => value ? new Date(value).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : 'Not recorded';
const titleFor = (entry: JsonObject) => String(entry.content || '').split('\n')[0].slice(0, 100) || entry.id;
const localDateTime = (value?: string) => { if (!value) return ''; const date = new Date(value); return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16); };

export function MemoryPanel({ onError }: PanelProps) {
  const [query, setQuery] = useState('');
  const [entries, setEntries] = useState<JsonObject[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [entry, setEntry] = useState<JsonObject | null>(null);
  const [instructions, setInstructions] = useState('');
  const [instructionsSaved, setInstructionsSaved] = useState(false);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [draft, setDraft] = useState({ content: '', kind: 'user_fact', source: 'owner', category: '', tags: '', project: '', checkedAt: '' });
  const searchGeneration = useRef(0);
  const currentQuery = useRef(query);
  currentQuery.current = query;

  const load = async () => {
    const generation = ++searchGeneration.current;
    setLoading(true);
    try {
      const value = await api(`/memory?q=${encodeURIComponent(currentQuery.current)}`);
      if (generation === searchGeneration.current) setEntries(asList(value));
    } catch (cause: any) { if (generation === searchGeneration.current) onError(cause.message); }
    finally { if (generation === searchGeneration.current) setLoading(false); }
  };
  useEffect(() => {
    const timeout = window.setTimeout(() => { void load(); }, 200);
    return () => { window.clearTimeout(timeout); searchGeneration.current++; };
  }, [query]);
  useEffect(() => { api<{ text: string }>('/instructions').then(value => setInstructions(value.text)).catch(cause => onError(cause.message)); }, []);
  useEffect(() => {
    setEntry(null);
    if (!selectedId) return;
    let alive = true;
    api<JsonObject>(`/memory/${encodeURIComponent(selectedId)}`).then(value => { if (alive) setEntry(value); }).catch(cause => { if (alive) onError(cause.message); });
    return () => { alive = false; };
  }, [selectedId]);
  const openEditor = (existing?: JsonObject) => {
    setDraft({ content: existing?.content || '', kind: existing?.kind || 'user_fact', source: existing?.source || 'owner', category: existing?.category || '', tags: (existing?.tags || []).join(', '), project: existing?.project || '', checkedAt: localDateTime(existing?.checkedAt) });
    if (!existing) { setSelectedId(null); setEntry(null); }
    setEditing(true);
  };
  const save = async (event: React.FormEvent) => {
    event.preventDefault(); setSaving(true);
    try {
      const result = await post<JsonObject>('/memory', { ...(entry ? { id: entry.id, expectedRevision: entry.revision } : {}), content: draft.content, kind: draft.kind, source: draft.source, category: draft.category || null, tags: draft.tags.split(',').map(tag => tag.trim()).filter(Boolean), project: draft.project || null, checkedAt: draft.kind === 'observation' ? new Date(draft.checkedAt).toISOString() : null });
      const value = result.entry || result;
      setSelectedId(value.id); setEntry(await api<JsonObject>(`/memory/${encodeURIComponent(value.id)}`)); setEditing(false); await load();
    } catch (cause: any) { onError(cause.message); } finally { setSaving(false); }
  };
  const saveInstructions = async () => {
    setSaving(true);
    try { await api('/instructions', { method: 'PUT', body: JSON.stringify({ text: instructions }) }); setInstructionsSaved(true); } catch (cause: any) { onError(cause.message); } finally { setSaving(false); }
  };
  return <section className="resource-panel"><div className="page-heading"><div><div className="eyebrow">DURABLE BRAIN</div><h1>Memory</h1><p>Knowledge that carries into the next conversation.</p></div><button className="primary-button" onClick={() => openEditor()}><Icon name="plus" size={16} />Add memory</button></div>
    <details className="instructions-card"><summary><span className="instructions-icon"><Icon name="settings" size={17} /></span><span><strong>Standing owner instructions</strong><small>Included in each session’s bounded bootstrap</small></span><Icon name="chevron" size={16} /></summary><div className="instructions-body"><label className="sr-only" htmlFor="owner-instructions">Standing owner instructions</label><textarea id="owner-instructions" rows={5} value={instructions} onChange={event => { setInstructions(event.target.value); setInstructionsSaved(false); }} placeholder="Describe your operator’s purpose, preferences, and standing instructions…" /><div className="inline-actions"><span className="small-note">Retrieved memories retain their provenance and do not become owner instructions.</span><button className="primary-button" onClick={() => void saveInstructions()} disabled={saving}>{instructionsSaved ? <><Icon name="check" size={14} />Saved</> : 'Save instructions'}</button></div></div></details>
    <div className="resource-grid"><div className="resource-list-panel"><label className="search-field"><Icon name="search" size={17} /><input aria-label="Search memory" value={query} onChange={event => setQuery(event.target.value)} placeholder="Search memory…" /></label><div className="list-count">{loading ? 'Searching…' : `${entries.length} ${entries.length === 1 ? 'entry' : 'entries'}`}</div><div className="resource-list">{entries.map(item => <button key={item.id} className={`resource-row ${selectedId === item.id ? 'selected' : ''}`} onClick={() => { setSelectedId(item.id); setEditing(false); }}><div className="resource-row-meta"><span className={`kind-label ${item.kind}`}>{String(item.kind || 'memory').replaceAll('_', ' ')}</span><span>r{item.revision}</span></div><strong>{titleFor(item)}</strong><p>{String(item.content).slice(0, 160)}</p><div className="tag-row">{(item.tags || []).slice(0, 3).map((tag: string) => <span key={tag}>{tag}</span>)}{item.project && <span>{item.project}</span>}</div></button>)}{!loading && entries.length === 0 && <EmptyState icon="brain" title={query ? 'No matching memories' : 'A clear mind'} text={query ? 'Try another word or phrase.' : 'Save a fact, an observation, or a lesson. Your operator can read and update these through its memory tools.'} />}</div></div>
      <div className="resource-detail">
        {editing ? <form className="memory-editor" onSubmit={save}><div className="detail-heading"><h2>{entry ? 'Edit memory' : 'New memory'}</h2><button type="button" className="icon-button" aria-label="Close memory editor" onClick={() => setEditing(false)}><Icon name="close" /></button></div><label htmlFor="memory-content">Content</label><textarea id="memory-content" value={draft.content} onChange={event => setDraft(previous => ({ ...previous, content: event.target.value }))} rows={8} required placeholder="A useful, durable piece of knowledge…" /><div className="form-row"><div><label htmlFor="memory-kind">Provenance</label><select id="memory-kind" value={draft.kind} onChange={event => setDraft(previous => ({ ...previous, kind: event.target.value }))}><option value="user_fact">User-provided fact</option><option value="observation">Machine observation</option><option value="inference">Agent inference</option></select></div><div><label htmlFor="memory-source">Source</label><input id="memory-source" value={draft.source} onChange={event => setDraft(previous => ({ ...previous, source: event.target.value }))} required /></div></div>{draft.kind === 'observation' && <><label htmlFor="memory-checked">Checked at</label><input id="memory-checked" type="datetime-local" value={draft.checkedAt.slice(0, 16)} onChange={event => setDraft(previous => ({ ...previous, checkedAt: event.target.value }))} required /></>}<div className="form-row"><div><label htmlFor="memory-category">Category</label><input id="memory-category" value={draft.category} onChange={event => setDraft(previous => ({ ...previous, category: event.target.value }))} placeholder="Optional" /></div><div><label htmlFor="memory-project">Project</label><input id="memory-project" value={draft.project} onChange={event => setDraft(previous => ({ ...previous, project: event.target.value }))} placeholder="Optional" /></div></div><label htmlFor="memory-tags">Tags</label><input id="memory-tags" value={draft.tags} onChange={event => setDraft(previous => ({ ...previous, tags: event.target.value }))} placeholder="Comma-separated tags" /><div className="editor-actions"><button type="button" className="secondary-button" onClick={() => setEditing(false)}>Cancel</button><button className="primary-button" disabled={saving || !draft.content.trim()}>{saving ? 'Saving…' : 'Save memory'}</button></div></form> : entry ? <><div className="detail-heading"><span className={`kind-label ${entry.kind}`}>{String(entry.kind).replaceAll('_', ' ')}</span><button className="subtle-button" onClick={() => openEditor(entry)}>Edit memory<Icon name="settings" size={14} /></button></div><h2>{titleFor(entry)}</h2><div className="memory-body">{entry.content}</div><dl className="metadata"><dt>Source</dt><dd>{entry.source}</dd><dt>State</dt><dd>{entry.state}</dd><dt>Revision</dt><dd>{entry.revision}</dd>{entry.category && <><dt>Category</dt><dd>{entry.category}</dd></>}{entry.project && <><dt>Project</dt><dd>{entry.project}</dd></>}<dt>Updated</dt><dd>{dateLabel(entry.updatedAt)}</dd>{entry.checkedAt && <><dt>Observed</dt><dd>{dateLabel(entry.checkedAt)}</dd></>}<dt>Stable ID</dt><dd><code>{entry.id}</code></dd></dl><div className="tag-row">{(entry.tags || []).map((tag: string) => <span key={tag}>{tag}</span>)}</div>{entry.supersededBy && <p className="small-note">Superseded by <button className="text-button" onClick={() => setSelectedId(entry.supersededBy)}>{entry.supersededBy}</button></p>}{entry.links?.length > 0 && <div className="detail-section"><h3>Linked memories</h3>{entry.links.map((link: JsonObject, index: number) => <button key={index} className="linked-memory" onClick={() => setSelectedId(link.fromId === entry.id ? link.toId : link.fromId)}><Icon name="link" size={13} />{link.relation}<code>{link.fromId === entry.id ? link.toId : link.fromId}</code></button>)}</div>}<div className="detail-section"><h3>Revision history <span>{entry.revisions?.length || 0}</span></h3>{(entry.revisions || []).map((revision: JsonObject) => <details className="revision" key={revision.revision}><summary><strong>Revision {revision.revision}</strong><time>{dateLabel(revision.createdAt)}</time><Icon name="chevron" size={13} /></summary><pre>{revision.snapshot?.content || JSON.stringify(revision.snapshot, null, 2)}</pre><span className="small-note">{revision.snapshot?.kind} · {revision.snapshot?.source}</span></details>)}</div></> : <EmptyState icon="brain" title="Keep the context" text="Select a memory to inspect its source, linked entries, and revision history." />}
      </div></div>
  </section>;
}

export function SkillsPanel({ onError }: PanelProps) {
  const [skills, setSkills] = useState<JsonObject[]>([]);
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<JsonObject | null>(null);
  const [version, setVersion] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const currentSelection = useRef(selected);
  currentSelection.current = selected;
  const detailGeneration = useRef(0);
  const load = async () => { try { setSkills(asList(await api('/skills'))); } catch (cause: any) { onError(cause.message); } };
  useEffect(() => { void load(); }, []);
  const loadDetail = async (name: string) => {
    if (currentSelection.current !== name) return;
    const generation = ++detailGeneration.current;
    try {
      const result = await api<JsonObject>(`/skills/${encodeURIComponent(name)}`);
      if (generation !== detailGeneration.current || currentSelection.current !== name) return;
      setDetail(result); setVersion(result.activeVersion ?? result.versions?.[0]?.version ?? null);
    } catch (cause: any) { if (generation === detailGeneration.current && currentSelection.current === name) onError(cause.message); }
  };
  useEffect(() => {
    setDetail(null); setVersion(null);
    if (selected) void loadDetail(selected);
    return () => { detailGeneration.current++; };
  }, [selected]);
  const action = async (type: string, targetVersion?: number | null) => {
    if (!selected || detail?.name !== selected || busy) return;
    setBusy(true);
    try { await post(`/skills/${encodeURIComponent(selected)}/action`, { action: type, ...(targetVersion !== null && targetVersion !== undefined ? { version: String(targetVersion) } : {}) }); await Promise.all([load(), loadDetail(selected)]); } catch (cause: any) { onError(cause.message); } finally { setBusy(false); }
  };
  const versions = Array.isArray(detail?.versions) ? detail.versions as JsonObject[] : [];
  const chosenVersion = versions.find(item => Number(item.version) === Number(version));
  const filtered = skills.filter(skill => `${skill.name} ${skill.description}`.toLowerCase().includes(query.toLowerCase()));
  return <section className="resource-panel"><div className="page-heading"><div><div className="eyebrow">PROCEDURAL KNOWLEDGE</div><h1>Skills</h1><p>Reusable workflows, tested and versioned on your machine.</p></div><button className="secondary-button" onClick={() => void load()}><Icon name="refresh" size={15} />Refresh</button></div><div className="skills-explainer"><Icon name="skill" size={18} /><span>Your operator can create, check, and activate skills through its tools. Every published version is preserved for inspection and rollback.</span></div><div className="resource-grid"><div className="resource-list-panel"><label className="search-field"><Icon name="search" size={17} /><input aria-label="Search skills" value={query} onChange={event => setQuery(event.target.value)} placeholder="Find a skill…" /></label><div className="list-count">{filtered.length} {filtered.length === 1 ? 'skill' : 'skills'}</div><div className="resource-list">{filtered.map(skill => <button key={skill.name} className={`resource-row skill-row ${selected === skill.name ? 'selected' : ''}`} onClick={() => setSelected(skill.name)}><div className="resource-row-meta"><Icon name="skill" size={17} /><span className={`state-label ${skill.state}`}>{skill.state}</span></div><strong>{skill.name}</strong><p>{skill.description}</p><div className="skill-row-footer"><span>{skill.activeVersion ? `Active v${skill.activeVersion}` : 'No active version'}</span><span>{skill.versions} {skill.versions === 1 ? 'version' : 'versions'}</span></div></button>)}{filtered.length === 0 && <EmptyState icon="skill" title="No skills found" text="Ask your operator to search or create a skill for a reusable task." />}</div></div><div className="resource-detail">{detail ? <><div className="detail-heading"><span className={`state-label ${detail.state}`}>{detail.state}</span><div className="button-group">{detail.state === 'active' ? <button className="secondary-button" disabled={busy} onClick={() => void action('disable')}>Disable</button> : detail.activeVersion ? <button className="primary-button" disabled={busy} onClick={() => void action('activate', detail.activeVersion)}>Enable</button> : null}{detail.state !== 'retired' && <button className="subtle-button danger" disabled={busy} onClick={() => void action('retire')}>Retire</button>}</div></div><h2>{detail.name}</h2><p className="detail-description">{detail.description}</p><label className="version-picker">Inspect version<select aria-label="Skill version" value={version ?? ''} onChange={event => setVersion(Number(event.target.value))}>{versions.map(item => <option value={item.version} key={item.version}>Version {item.version} · {item.state}{detail.activeVersion === item.version ? ' · current' : ''}</option>)}</select></label>{chosenVersion && <><div className="version-summary"><span className={`state-label ${chosenVersion.state}`}>{chosenVersion.state}</span><span>{dateLabel(chosenVersion.publishedAt || chosenVersion.createdAt)}</span>{Number(chosenVersion.version) !== Number(detail.activeVersion) && chosenVersion.publishedAt && <button className="secondary-button" disabled={busy} onClick={() => void action('rollback', Number(chosenVersion.version))}>Roll back to v{chosenVersion.version}</button>}{!detail.activeVersion && chosenVersion.publishedAt && <button className="primary-button" disabled={busy} onClick={() => void action('activate', Number(chosenVersion.version))}>Activate v{chosenVersion.version}</button>}</div><div className="detail-section"><h3>Instructions</h3><pre className="skill-body">{chosenVersion.body}</pre></div><details className="detail-section evidence" open><summary><h3>Validation evidence</h3><Icon name="chevron" size={14} /></summary><pre>{chosenVersion.evidence ? typeof chosenVersion.evidence === 'string' ? chosenVersion.evidence : JSON.stringify(chosenVersion.evidence, null, 2) : 'No validation evidence recorded for this version.'}</pre></details><details className="detail-section evidence"><summary><h3>Package files <span>{chosenVersion.files?.length || 0}</span></h3><Icon name="chevron" size={14} /></summary><ul className="file-list">{(chosenVersion.files || []).map((file: string) => <li key={file}><Icon name="folder" size={13} /><code>{file}</code></li>)}</ul><div className="small-note mono">{chosenVersion.path}</div></details></>}<details className="detail-section evidence"><summary><h3>Recorded usage <span>{detail.usage?.length || 0}</span></h3><Icon name="chevron" size={14} /></summary>{detail.usage?.length ? <pre>{JSON.stringify(detail.usage, null, 2)}</pre> : <p className="small-note">No runtime usage has been recorded yet.</p>}</details></> : <EmptyState icon="skill" title="A growing toolkit" text="Select a skill to inspect immutable versions, representative checks, and actual usage evidence." />}</div></div></section>;
}

export function ArtifactsPanel({ onError }: PanelProps) {
  const [files, setFiles] = useState<JsonObject[]>([]);
  const [loading, setLoading] = useState(true);
  const load = async () => { setLoading(true); try { setFiles(asList(await api('/artifacts'))); } catch (cause: any) { onError(cause.message); } finally { setLoading(false); } };
  useEffect(() => { void load(); }, []);
  const bytes = (size: number) => size < 1024 ? `${size} B` : size < 1024 * 1024 ? `${(size / 1024).toFixed(1)} KB` : `${(size / 1024 / 1024).toFixed(1)} MB`;
  return <section className="resource-panel"><div className="page-heading"><div><div className="eyebrow">WORK THAT LASTS</div><h1>Artifacts</h1><p>Files your operator saved to the durable artifacts directory.</p></div><button className="secondary-button" onClick={() => void load()}><Icon name="refresh" size={15} />Refresh</button></div><div className="artifact-card">{files.length ? <><div className="artifact-header"><span>FILE</span><span>SIZE</span><span /></div>{files.map(file => <a className="artifact-row" href={`/api/artifacts/${String(file.path).split('/').map(encodeURIComponent).join('/')}`} target="_blank" rel="noreferrer" key={file.path}><Icon name="folder" size={18} /><span>{file.path}</span><span>{bytes(file.size)}</span><Icon name="arrow" size={16} style={{ transform: 'rotate(45deg)' }} /></a>)}</> : <EmptyState icon="folder" title={loading ? 'Loading artifacts…' : 'Your work, collected'} text="Ask your operator to save a report or other output in the artifacts directory. Downloads use your authenticated session." />}</div></section>;
}

function EmptyState({ icon, title, text }: { icon: 'brain' | 'skill' | 'folder'; title: string; text: string }) { return <div className="resource-empty"><div className="resource-empty-icon"><Icon name={icon} size={25} /></div><h2>{title}</h2><p>{text}</p></div>; }
