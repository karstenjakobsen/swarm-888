import { useCallback, useEffect, useRef, useState } from 'react';
import type { AgentConnection as Connection } from '../src/agent-connection-schema';
import { api, post } from './api';
import { Icon } from './icons';
import type { WorkerHealth } from './types';

const verificationUrl = 'https://auth.openai.com/codex/device';

export function AgentConnection({ open, onClose, worker, onStatusChanged }: {
  open: boolean;
  onClose: () => void;
  worker: WorkerHealth | null | undefined;
  onStatusChanged: () => Promise<void>;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [connection, setConnection] = useState<Connection | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [refreshError, setRefreshError] = useState('');
  const [copied, setCopied] = useState(false);
  const [commandCopied, setCommandCopied] = useState(false);
  const currentConnection = useRef<Connection | null>(null);
  const actionPending = useRef(false);
  const refreshPending = useRef(false);
  const requestGeneration = useRef(0);
  const mounted = useRef(true);

  useEffect(() => { mounted.current = true; return () => { mounted.current = false; requestGeneration.current++; }; }, []);
  useEffect(() => { setCommandCopied(false); }, [connection?.rootWorkerCommand]);

  const acceptConnection = useCallback((value: Connection) => {
    const previous = currentConnection.current;
    currentConnection.current = value;
    setConnection(value);
    if (previous?.workerSetupRequired && !value.workerSetupRequired && value.state === 'connected') setError('');
    if ((value.state === 'connected' && previous?.state !== 'connected') || value.workerConnected !== previous?.workerConnected || value.workerSetupRequired !== previous?.workerSetupRequired) {
      void onStatusChanged().catch(() => {});
    }
  }, [onStatusChanged]);

  const refresh = useCallback(async () => {
    if (actionPending.current || refreshPending.current) return;
    refreshPending.current = true;
    const generation = requestGeneration.current;
    try {
      const value = await api<Connection>('/agent/connection');
      if (!mounted.current || generation !== requestGeneration.current) return;
      acceptConnection(value);
      setRefreshError('');
    } catch (cause: unknown) {
      if (mounted.current && generation === requestGeneration.current) setRefreshError(cause instanceof Error ? cause.message : 'Could not check the agent connection.');
    } finally {
      refreshPending.current = false;
      if (mounted.current && generation === requestGeneration.current) setLoading(false);
    }
  }, [acceptConnection]);

  useEffect(() => {
    if (!open && connection?.state !== 'connecting') return;
    if (open && !currentConnection.current) setLoading(true);
    void refresh();
    const interval = window.setInterval(() => { void refresh(); }, 2000);
    return () => { window.clearInterval(interval); };
  }, [open, connection?.state, refresh]);

  useEffect(() => {
    const element = dialog.current;
    if (!element || !open) return;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    element.showModal();
    return () => { element.close(); previousFocus?.focus(); };
  }, [open]);

  const act = async (action: 'connect' | 'cancel' | 'worker') => {
    if (actionPending.current) return;
    actionPending.current = true;
    requestGeneration.current++;
    setBusy(true); setLoading(false); setError(''); setRefreshError(''); setCopied(false);
    try {
      const value = await post<Connection>(`/agent/${action}`);
      if (mounted.current) acceptConnection(value);
    } catch (cause: unknown) {
      if (mounted.current) setError(cause instanceof Error ? cause.message : 'Could not update the agent connection.');
    } finally {
      actionPending.current = false;
      if (mounted.current) setBusy(false);
    }
  };

  const copyCode = async () => {
    if (!connection?.userCode) return;
    try { await navigator.clipboard.writeText(connection.userCode); setCopied(true); }
    catch { setError('Copy is unavailable here. Select the code and copy it manually.'); }
  };
  const copyWorkerCommand = async () => {
    if (!connection?.rootWorkerCommand) return;
    try { await navigator.clipboard.writeText(connection.rootWorkerCommand); setCommandCopied(true); }
    catch { setError('Copy is unavailable here. Select the setup command and copy it manually.'); }
  };

  const workerConnected = connection?.workerConnected ?? Boolean(worker);
  const workerUid = connection?.workerUid ?? worker?.uid;
  const executionUid = connection?.executionUid ?? worker?.executionUid ?? workerUid;
  const rootWorker = workerConnected && workerUid === 0 && executionUid === 0;
  const setupRequired = connection?.workerSetupRequired === true;
  const state = connection?.state;
  const validCode = state === 'connecting' && connection?.verificationUrl === verificationUrl && connection.userCode;
  const expires = connection?.expiresAt ? new Date(connection.expiresAt) : null;

  return <dialog ref={dialog} className="agent-dialog" aria-labelledby="agent-dialog-title" aria-describedby="agent-dialog-description" onCancel={event => { event.preventDefault(); onClose(); }} onClick={event => { if (event.target === event.currentTarget) onClose(); }}>
    {open && <div className="agent-dialog-content">
      <header className="agent-dialog-heading"><div className="agent-dialog-symbol"><Icon name="skill" size={23} /></div><button className="icon-button" aria-label="Close agent connection" onClick={onClose}><Icon name="close" /></button></header>
      <div className="eyebrow">YOUR OPERATOR</div>
      <h2 id="agent-dialog-title">{setupRequired ? 'Restart the root worker' : state === 'connected' && rootWorker ? 'Agent connected' : 'Connect your agent'}</h2>
      <p id="agent-dialog-description">{setupRequired ? 'Apply the current worker configuration. The worker will reuse its saved ChatGPT sign-in.' : 'Connect your ChatGPT account to let the agent work on your tasks.'}</p>
      <div className="agent-worker-identity" title={workerConnected ? `Actual execution UID ${executionUid ?? 'unknown'}` : undefined}><span className={`status-dot ${rootWorker ? 'ok' : ''}`} /><span>{workerConnected ? `Worker connected · UID ${executionUid ?? 'unknown'} · ${rootWorker ? 'root' : 'non-root'}` : 'Worker disconnected'}</span></div>

      {(error || refreshError) && <div className="inline-error agent-connection-error" role="alert">{error || refreshError}</div>}
      {connection?.error && connection.error !== error && <div className="inline-error agent-connection-error" role="alert">{connection.error}</div>}

      {loading ? <div className="agent-connection-wait" role="status"><Icon name="refresh" size={15} />Checking your connection…</div> : !rootWorker || setupRequired ? <div className="agent-connection-section">
        <h3>{setupRequired ? 'Worker configuration changed' : workerConnected ? 'A root worker is required' : 'Start the root worker'}</h3>
        <p>{setupRequired ? 'Restart the connected worker with this controller’s current configuration. The launcher verifies that the old worker is idle before replacing it. Active or uncertain workers stay running.' : 'The worker runs project commands with root access. Start it, then connect your ChatGPT account. The agent is instructed to leave operator files unchanged.'}</p>
        <button className="primary-button" disabled={busy} onClick={() => void act('worker')}><Icon name="terminal" size={16} />{setupRequired ? busy ? 'Restarting root worker…' : 'Restart root worker' : busy ? 'Starting root worker…' : 'Start root worker'}</button>
        {(setupRequired || error || refreshError || connection?.error) && connection?.rootWorkerCommand && <div className="agent-root-setup"><h3>Host setup</h3>{setupRequired ? <><p>In the operator directory, run this as your normal user without a sudo prefix. It loads the current .env configuration, then asks for your sudo password.</p><code aria-label="Root worker restart command">npm run worker:root</code><p>Alternatively, copy this exact command for the current controller configuration. The connection updates after the verified idle worker is replaced.</p></> : <p>If the host requires administrator permission, run this command on the VPS, then try again here.</p>}<code aria-label="Worker setup command">{connection.rootWorkerCommand}</code><button className="secondary-button" aria-label="Copy worker command" onClick={() => void copyWorkerCommand()}>{commandCopied ? 'Copied' : setupRequired ? 'Copy exact command' : 'Copy command'}</button></div>}
      </div> : state === 'connected' ? <div className="agent-connection-section agent-connected">
        <div className="agent-success-mark"><Icon name="check" size={22} /></div>
        <h3>Ready to work</h3>
        <p>Your ChatGPT account is connected. Saved tasks resume automatically when the queue is ready.</p>
        <button className="primary-button" onClick={onClose}>Back to workspace<Icon name="chevron" size={15} /></button>
      </div> : state === 'connecting' ? <div className="agent-connection-section">
        <h3>Finish signing in with ChatGPT</h3>
        <p>Open the sign-in page and enter this one-time code.</p>
        {validCode ? <>
          <div className="agent-device-code"><code aria-label="One-time sign-in code">{connection.userCode}</code><button className="secondary-button" onClick={() => void copyCode()} aria-label="Copy sign-in code">{copied ? 'Copied' : 'Copy code'}</button></div>
          <a className="primary-button agent-signin-link" href={verificationUrl} target="_blank" rel="noopener noreferrer">Open ChatGPT sign-in<Icon name="link" size={15} /></a>
          <p className="small-note">auth.openai.com{expires && !Number.isNaN(expires.getTime()) ? ` · Code expires at ${expires.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : ''}</p>
        </> : <p className="small-note">Preparing or confirming your ChatGPT connection…</p>}
        <div className="agent-connection-wait" role="status"><span className="status-dot" />Waiting for you to finish signing in…</div>
        <button className="secondary-button" disabled={busy} onClick={() => void act('cancel')}>{busy ? 'Canceling…' : 'Cancel sign-in'}</button>
      </div> : <div className="agent-connection-section">
        <h3>{state === 'error' ? 'Sign-in needs attention' : 'Sign in with ChatGPT'}</h3>
        <p>Use your ChatGPT account for this agent. Your queued tasks stay saved while you connect.</p>
        <button className="primary-button" disabled={busy} onClick={() => void act('connect')}><Icon name="link" size={16} />{busy ? 'Preparing sign-in…' : state === 'error' ? 'Retry ChatGPT sign-in' : 'Continue with ChatGPT'}</button>
        <p className="small-note">You’ll finish signing in on OpenAI’s website, then return here.</p>
      </div>}
    </div>}
  </dialog>;
}
