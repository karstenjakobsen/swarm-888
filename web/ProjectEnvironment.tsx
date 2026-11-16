import { useCallback, useEffect, useRef, useState } from 'react';
import type { CredentialMetadata, ProjectEnvironment as EnvironmentReference } from '../src/credentials/schemas';
import { api } from './api';
import { Icon } from './icons';
import { managementError } from './management';

interface EnvironmentState { environment: EnvironmentReference | null; readiness: { ready: boolean; reason?: string } }
const mappingText = (value: EnvironmentReference | null) => value ? Object.entries(value.bindings).map(([target, field]) => `${target}=${field}`).join('\n') : '';

export function ProjectEnvironment({ projectId, disabled }: { projectId: string; disabled: boolean }) {
  const [snapshot, setSnapshot] = useState<EnvironmentState | null>(null), [credentials, setCredentials] = useState<CredentialMetadata[]>([]);
  const [credentialId, setCredentialId] = useState(''), [bindings, setBindings] = useState(''), [loading, setLoading] = useState(true), [busy, setBusy] = useState(false), [notice, setNotice] = useState(''), [error, setError] = useState('');
  const generation = useRef(0), pending = useRef(false), mounted = useRef(true);
  const endpoint = `/projects/${encodeURIComponent(projectId)}/environment`;
  const apply = (value: EnvironmentState) => { setSnapshot(value); setCredentialId(value.environment?.credentialId ?? ''); setBindings(mappingText(value.environment)); };
  const load = useCallback(async () => {
    const request = ++generation.current; setLoading(true); setError('');
    try { const [value, metadata] = await Promise.all([api<EnvironmentState>(endpoint), api<CredentialMetadata[]>('/credentials')]); if (request === generation.current) { apply(value); setCredentials(metadata); } }
    catch (cause) { if (request === generation.current) setError(managementError(cause)); }
    finally { if (request === generation.current) setLoading(false); }
  }, [endpoint]);
  useEffect(() => { mounted.current = true; void load(); return () => { mounted.current = false; generation.current++; }; }, [load]);
  const save = async (clear = false) => {
    if (pending.current || disabled || loading || !snapshot) return;
    let environment: EnvironmentReference | null = null;
    if (!clear) {
      const entries = bindings.split('\n').map(line => line.trim()).filter(Boolean).map(line => line.match(/^([A-Z_][A-Z0-9_]*)\s*=\s*([A-Za-z_][A-Za-z0-9_.-]*)$/));
      if (!credentialId || !entries.length || entries.some(value => !value)) { setError('Choose a saved credential and enter ENV_NAME=credential_field on each line.'); return; }
      const values = entries.map(value => [value![1]!, value![2]!] as const);
      if (new Set(values.map(([name]) => name)).size !== values.length) { setError('Each environment variable can be bound only once.'); return; }
      environment = { credentialId, bindings: Object.fromEntries(values) };
    }
    pending.current = true; setBusy(true); setError(''); setNotice(''); const request = generation.current;
    try { const result = await api<EnvironmentState>(endpoint, { method: 'PUT', body: JSON.stringify({ environment }) }); if (mounted.current && request === generation.current) { apply(result); setNotice(clear ? 'Runtime credential binding cleared. Redeploy to apply the change before restarting the old unit.' : 'Runtime credential binding saved. Redeploy to apply it before restarting the old unit.'); } }
    catch (cause) { if (mounted.current && request === generation.current) setError(managementError(cause)); }
    finally { pending.current = false; if (mounted.current && request === generation.current) setBusy(false); }
  };
  return <section className="platform-section project-environment" aria-label="Runtime credentials"><div className="project-section-heading"><h3><Icon name="link" size={14} />Runtime credentials</h3>{snapshot && <span className={`connection-status ${snapshot.readiness.ready ? 'connected' : 'error'}`}>{snapshot.readiness.ready ? snapshot.environment ? 'Configured' : 'No binding' : 'Setup required'}</span>}</div><p className="small-note">Bind saved credential fields to this app’s environment. Values stay outside source and Git. Changes apply on redeploy; existing processes keep their current environment. Replacing or clearing a binding revokes its old grant, so redeploy before restarting the old unit.</p>{snapshot?.readiness.reason && <p className="management-warning" role="status">{snapshot.readiness.reason}</p>}{loading ? <p className="small-note">Loading credential references…</p> : <fieldset className="plain-fieldset" disabled={disabled || busy || !snapshot}><label>Saved credential<select aria-label="Runtime saved credential" value={credentialId} onChange={event => { setCredentialId(event.target.value); setNotice(''); }}><option value="">Choose a saved credential</option>{credentialId && !credentials.some(value => value.id === credentialId) && <option value={credentialId}>Unavailable credential · {credentialId}</option>}{credentials.map(value => <option value={value.id} key={value.id}>{value.name} · {value.ready ? 'stored' : 'not ready'}</option>)}</select></label>{credentialId && <p className="small-note">Available fields: {credentials.find(value => value.id === credentialId)?.fields.join(', ') || 'Not available'}</p>}<label>Environment bindings<textarea aria-label="Runtime environment bindings" rows={4} spellCheck={false} value={bindings} onChange={event => { setBindings(event.target.value); setNotice(''); }} placeholder={'API_KEY=token\nAPI_SECRET=secret'} /></label><div className="source-actions"><button className="primary-button" disabled={!credentialId} onClick={() => void save()}>{busy ? 'Saving…' : 'Save runtime credentials'}</button><button className="secondary-button" disabled={!snapshot?.environment} onClick={() => void save(true)}>Clear runtime credentials</button></div></fieldset>}{error && <div className="inline-error" role="alert">{error}{!snapshot && <button className="text-button" onClick={() => void load()}>Retry loading</button>}</div>}{notice && <p className="management-notice" role="status">{notice}</p>}</section>;
}
