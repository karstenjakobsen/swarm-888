import { useCallback, useEffect, useRef, useState } from 'react';
import type { ConnectorAuth, CredentialMetadata } from '../src/credentials/schemas';
import { api, post } from './api';
import { Icon } from './icons';
import { managementError, type Connector } from './management';

interface OAuthSession { authorizationUrl: string; expiresAt: string; credential: CredentialMetadata }
interface OAuthStatus { readiness?: { ready: boolean; reason?: string }; credential?: CredentialMetadata }

export function ConnectorCredentials({ connector, disabled, onBusyChange, onUpdated, onError }: {
  connector: Connector; disabled: boolean; onBusyChange: (busy: boolean) => void; onUpdated: () => Promise<void>; onError: (message: string) => void;
}) {
  const [credentials, setCredentials] = useState<CredentialMetadata[]>([]);
  const [kind, setKind] = useState<ConnectorAuth['type'] | 'none'>(connector.auth?.type ?? 'none');
  const [credentialId, setCredentialId] = useState(connector.auth?.credentialId ?? ''), [name, setName] = useState(`${connector.name} credential`);
  const [fields, setFields] = useState([{ name: 'token', value: '', stored: false }]);
  const [tokenField, setTokenField] = useState(connector.auth?.type === 'bearer' ? connector.auth.field : 'token');
  const [bindings, setBindings] = useState(connector.auth && 'bindings' in connector.auth ? JSON.stringify(connector.auth.bindings, null, 2) : '{}');
  const [oauth, setOAuth] = useState({ authorizationUrl: '', tokenUrl: '', clientId: '', clientSecret: '', scopes: '', tokenAuthMethod: 'none', tokenMethod: 'POST', accessToken: 'access_token', refreshToken: 'refresh_token', expiresIn: 'expires_in' });
  const [oauthSession, setOAuthSession] = useState<OAuthSession | null>(null), [oauthStatus, setOAuthStatus] = useState<OAuthStatus | null>(null), [oauthWaiting, setOAuthWaiting] = useState(false);
  const [busy, setBusy] = useState(false), [notice, setNotice] = useState(''), [error, setError] = useState('');
  const mounted = useRef(true), pending = useRef(false), generation = useRef(0);
  const base = `/connectors/${encodeURIComponent(connector.id)}`;
  const metadata = credentials.find(value => value.id === credentialId);
  const bindingKey = JSON.stringify(connector.auth ?? null);
  const loadCredentials = useCallback(async () => { const value = await api<CredentialMetadata[]>('/credentials'); if (mounted.current) setCredentials(value); return value; }, []);
  useEffect(() => { mounted.current = true; void loadCredentials().catch(cause => { if (mounted.current) onError(managementError(cause)); }); return () => { mounted.current = false; generation.current++; onBusyChange(false); }; }, [loadCredentials, onBusyChange, onError]);
  useEffect(() => { setKind(connector.auth?.type ?? 'none'); setCredentialId(connector.auth?.credentialId ?? ''); if (connector.auth?.type === 'bearer') setTokenField(connector.auth.field); if (connector.auth && 'bindings' in connector.auth) setBindings(JSON.stringify(connector.auth.bindings, null, 2)); }, [bindingKey]);
  useEffect(() => { if (metadata) setFields(previous => previous.some(field => field.value) ? previous : metadata.fields.map(field => ({ name: field, value: '', stored: true }))); }, [metadata?.id, metadata?.revision]);
  useEffect(() => {
    if (kind !== 'oauth2') return;
    let alive = true;
    const refresh = async () => {
      if (pending.current) return;
      try {
        const value = await api<OAuthStatus>(`${base}/oauth/status`);
        if (!alive) return;
        setOAuthStatus(value);
        if (value.readiness?.ready && oauthWaiting) { setOAuthWaiting(false); setOAuthSession(null); setNotice('Account authorization is ready.'); await loadCredentials(); await onUpdated(); }
      } catch (cause) { if (alive) setError(managementError(cause)); }
    };
    void refresh(); const interval = window.setInterval(() => void refresh(), 2000);
    return () => { alive = false; window.clearInterval(interval); };
  }, [base, kind, oauthWaiting, onUpdated]);
  const chooseCredential = (id: string) => {
    setCredentialId(id); setNotice(''); setError('');
    const value = credentials.find(item => item.id === id);
    setFields(value ? value.fields.map(field => ({ name: field, value: '', stored: true })) : [{ name: 'token', value: '', stored: false }]);
  };
  const action = async (operation: () => Promise<void>) => {
    if (pending.current || disabled) return;
    pending.current = true; setBusy(true); onBusyChange(true); setError(''); setNotice(''); const request = generation.current;
    try { await operation(); }
    catch (cause) { if (mounted.current && request === generation.current) setError(managementError(cause)); }
    finally { pending.current = false; if (mounted.current && request === generation.current) { setBusy(false); onBusyChange(false); } }
  };
  const save = () => action(async () => {
    if (kind === 'none') { await api(`${base}/auth`, { method: 'PUT', body: JSON.stringify({ auth: null }) }); if (mounted.current) { setFields([{ name: 'token', value: '', stored: false }]); setNotice('Connection authentication removed. Stored credentials are retained.'); await onUpdated(); } return; }
    if (kind === 'oauth2') return;
    let mapping: Record<string, string> = {};
    if (kind !== 'bearer') {
      let parsed: unknown; try { parsed = JSON.parse(bindings); } catch { throw new Error('Bindings must be valid JSON mapping target names to credential field names.'); }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || !Object.keys(parsed).length || Object.values(parsed).some(value => typeof value !== 'string')) throw new Error('Provide at least one binding from a header or environment name to a credential field.');
      mapping = parsed as Record<string, string>;
    }
    const values = Object.fromEntries(fields.filter(field => field.value).map(field => [field.name.trim(), field.value]));
    if (Object.keys(values).length !== fields.filter(field => field.value).length) throw new Error('Credential field names must be unique.');
    if (Object.values(values).some(value => value.length < 8)) throw new Error('Credential values must contain at least 8 characters.');
    if (Object.keys(values).some(field => !/^[A-Za-z_][A-Za-z0-9_.-]{0,99}$/.test(field))) throw new Error('Use valid credential field names.');
    let id = credentialId;
    if (!id && !Object.keys(values).length) throw new Error('Enter at least one credential value.');
    if (!id) { const created = await post<CredentialMetadata>('/credentials', { name, values }); id = created.id; if (mounted.current) { setCredentialId(id); setCredentials(previous => [...previous, created]); } }
    else if (Object.keys(values).length) await api(`/credentials/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify({ values }) });
    if (!mounted.current) return;
    setFields(previous => previous.map(field => ({ ...field, value: '', stored: true })));
    let auth: ConnectorAuth;
    if (kind === 'bearer') auth = { type: 'bearer', credentialId: id, field: tokenField };
    else {
      auth = { type: kind, credentialId: id, bindings: mapping };
    }
    await api(`${base}/auth`, { method: 'PUT', body: JSON.stringify({ auth }) });
    if (mounted.current) { await loadCredentials(); await onUpdated(); setNotice('Credential saved and granted to this connection. Values are never read back.'); }
  });
  const startOAuth = () => action(async () => {
    const result = await post<OAuthSession>(`${base}/oauth/start`, { name, authorizationUrl: oauth.authorizationUrl, tokenUrl: oauth.tokenUrl, clientId: oauth.clientId, ...(oauth.clientSecret ? { clientSecret: oauth.clientSecret } : {}), scopes: oauth.scopes.split(/[\s,]+/).filter(Boolean), tokenAuthMethod: oauth.tokenAuthMethod, tokenMethod: oauth.tokenMethod, tokenFields: { accessToken: oauth.accessToken, refreshToken: oauth.refreshToken, expiresIn: oauth.expiresIn } });
    if (!mounted.current) return;
    setOAuth(previous => ({ ...previous, clientSecret: '' })); setOAuthSession(result); setOAuthWaiting(true); await loadCredentials(); await onUpdated();
  });
  const cancelOAuth = () => action(async () => { await post(`${base}/oauth/cancel`); if (mounted.current) { setOAuthWaiting(false); setOAuthSession(null); setNotice('Authorization request canceled.'); await onUpdated(); } });
  const saveExistingOAuth = () => action(async () => { await api(`${base}/auth`, { method: 'PUT', body: JSON.stringify({ auth: { type: 'oauth2', credentialId } }) }); if (mounted.current) { await onUpdated(); setNotice('Saved authorization granted to this connection.'); } });
  return <section className="platform-section credential-setup" aria-label="Connection credentials"><div className="project-section-heading"><h3><Icon name="link" size={14} />Authentication</h3><span className={`connection-status ${connector.readiness?.ready === false ? 'error' : 'connected'}`}>{connector.readiness?.ready === false ? 'Setup required' : 'Ready'}</span></div><p className="small-note">Credential values are write-only. Store them here instead of in tasks, source files, commands, or URLs.</p>{connector.readiness?.reason && <p className="management-warning" role="status">{connector.readiness.reason}</p>}<fieldset className="plain-fieldset" disabled={busy || disabled}><label>Authentication method<select aria-label="Connection authentication method" value={kind} onChange={event => { setKind(event.target.value as typeof kind); setCredentialId(''); setFields([{ name: 'token', value: '', stored: false }]); setError(''); setNotice(''); }}><option value="none">None</option>{connector.transport === 'stdio' ? <option value="env">Environment variables</option> : <><option value="bearer">Bearer token</option><option value="headers">HTTP headers</option><option value="oauth2">OAuth 2.0 account</option></>}</select></label>{kind !== 'none' && <><label>Saved credential<select aria-label="Saved credential" value={credentialId} onChange={event => chooseCredential(event.target.value)}><option value="">Create a new credential</option>{credentials.filter(value => value.kind === (kind === 'oauth2' ? 'oauth2' : 'secret')).map(value => <option key={value.id} value={value.id}>{value.name} · {value.ready ? 'stored' : 'not ready'}</option>)}</select></label>{metadata && <p className="small-note">{metadata.kind === 'oauth2' ? `Authorization: ${metadata.ready ? 'ready' : 'pending'}` : `Stored fields: ${metadata.fields.join(', ') || 'None'}`}  · revision {metadata.revision}{metadata.expiresAt ? ` · expires ${new Date(metadata.expiresAt).toLocaleString()}` : ''}</p>}{!credentialId && <label>Credential name<input aria-label="Credential name" value={name} onChange={event => setName(event.target.value)} required maxLength={120} /></label>}</>}{kind === 'oauth2' ? <><p className="small-note">{oauthStatus?.readiness?.ready ? 'This account is authorized.' : oauthStatus?.readiness?.reason || 'Authorize an account using the provider’s OAuth configuration.'}</p>{credentialId && <button className="secondary-button" onClick={() => void saveExistingOAuth()}>Use saved authorization</button>}<details open={!connector.auth || connector.readiness?.ready === false || oauthWaiting} className="oauth-configuration"><summary>OAuth provider setup</summary><label>Authorization URL<input aria-label="OAuth authorization URL" type="url" value={oauth.authorizationUrl} onChange={event => setOAuth(previous => ({ ...previous, authorizationUrl: event.target.value }))} /></label><label>Token URL<input aria-label="OAuth token URL" type="url" value={oauth.tokenUrl} onChange={event => setOAuth(previous => ({ ...previous, tokenUrl: event.target.value }))} /></label><label>Client ID<input aria-label="OAuth client ID" value={oauth.clientId} onChange={event => setOAuth(previous => ({ ...previous, clientId: event.target.value }))} /></label><label>Client authentication<select aria-label="OAuth client authentication" value={oauth.tokenAuthMethod} onChange={event => setOAuth(previous => ({ ...previous, tokenAuthMethod: event.target.value, ...(event.target.value === 'none' ? { clientSecret: '' } : {}) }))}><option value="none">Public client · no secret</option><option value="client_secret_post">Client secret in token request</option><option value="client_secret_basic">Client secret with HTTP Basic</option></select></label>{oauth.tokenAuthMethod !== 'none' && <label>Client secret<input aria-label="OAuth client secret" type="password" minLength={8} placeholder="8 or more characters" autoComplete="new-password" value={oauth.clientSecret} onChange={event => setOAuth(previous => ({ ...previous, clientSecret: event.target.value }))} /></label>}<label>Scopes<input aria-label="OAuth scopes" value={oauth.scopes} onChange={event => setOAuth(previous => ({ ...previous, scopes: event.target.value }))} placeholder="Space-separated scopes" /></label><details className="oauth-advanced"><summary>Advanced token settings</summary><p className="small-note">Match the provider’s token request method and JSON response field names.</p><label>Token request method<select aria-label="OAuth token request method" value={oauth.tokenMethod} onChange={event => setOAuth(previous => ({ ...previous, tokenMethod: event.target.value }))}><option value="POST">POST</option><option value="GET">GET</option></select></label><label>Access token response field<input aria-label="OAuth access token response field" value={oauth.accessToken} maxLength={100} onChange={event => setOAuth(previous => ({ ...previous, accessToken: event.target.value }))} /></label><label>Refresh token response field<input aria-label="OAuth refresh token response field" value={oauth.refreshToken} maxLength={100} onChange={event => setOAuth(previous => ({ ...previous, refreshToken: event.target.value }))} /></label><label>Expiry response field<input aria-label="OAuth expiry response field" value={oauth.expiresIn} maxLength={100} onChange={event => setOAuth(previous => ({ ...previous, expiresIn: event.target.value }))} /></label></details><button className="primary-button" disabled={oauthWaiting || !oauth.authorizationUrl || !oauth.tokenUrl || !oauth.clientId || oauth.tokenAuthMethod !== 'none' && oauth.clientSecret.length < 8} onClick={() => void startOAuth()}>Start account authorization</button></details></> : kind !== 'none' ? <><div className="secret-fields">{fields.map((field, index) => <div className="secret-field-row" key={index}><label>Field name<input aria-label={`Credential field ${index + 1} name`} value={field.name} readOnly={field.stored} onChange={event => setFields(previous => previous.map((value, position) => position === index ? { ...value, name: event.target.value } : value))} /></label><label>{field.stored ? 'Replacement value' : 'Secret value'}<input aria-label={`Credential field ${index + 1} value`} type="password" minLength={8} autoComplete="new-password" value={field.value} placeholder={field.stored ? 'Leave blank to keep stored value' : 'Enter a secret (8+ characters)'} onChange={event => setFields(previous => previous.map((value, position) => position === index ? { ...value, value: event.target.value } : value))} /></label></div>)}</div><button className="subtle-button" onClick={() => setFields(previous => [...previous, { name: '', value: '', stored: false }])}><Icon name="plus" size={13} />Add credential field</button>{kind === 'bearer' ? <label>Token field<input aria-label="Bearer token field" value={tokenField} onChange={event => setTokenField(event.target.value)} /></label> : <label>{kind === 'env' ? 'Environment bindings (JSON)' : 'Header bindings (JSON)'}<textarea aria-label="Credential bindings JSON" value={bindings} onChange={event => setBindings(event.target.value)} rows={4} spellCheck={false} placeholder={kind === 'env' ? '{"API_KEY":"token"}' : '{"X-API-Key":"token"}'} /></label>}</> : null}{kind !== 'oauth2' && <button className="primary-button" onClick={() => void save()}>{busy ? 'Saving…' : kind === 'none' ? 'Save authentication method' : 'Save credentials & binding'}</button>}</fieldset>{oauthWaiting && oauthSession && <div className="oauth-pending" role="status"><p>Finish authorization with the provider. This request expires at {new Date(oauthSession.expiresAt).toLocaleTimeString()}.</p><a className="primary-button" href={oauthSession.authorizationUrl} target="_blank" rel="noopener noreferrer">Open provider authorization<Icon name="link" size={13} /></a><button className="secondary-button" disabled={busy || disabled} onClick={() => void cancelOAuth()}>Cancel authorization</button></div>}{error && <p className="inline-error" role="alert">{error}</p>}{notice && <p className="management-notice" role="status">{notice}</p>}</section>;
}
