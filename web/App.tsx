import { useCallback, useEffect, useRef, useState } from 'react';
import { api, asList, post, setCsrf } from './api';
import { Icon, type IconName } from './icons';
import { MemoryPanel, SkillsPanel, ArtifactsPanel } from './panels';
import { AgentConnection } from './AgentConnection';
import { ExecutionRecovery } from './ExecutionRecovery';
import { ProjectsPanel } from './ProjectsPanel';
import { RepositoriesPanel } from './RepositoriesPanel';
import { ConnectionsPanel } from './ConnectionsPanel';
import { WorkersPanel } from './WorkersPanel';
import { isWorkerReady } from './workers';
import { JobsPanel } from './JobsPanel';
import { RunExecutionMetadata } from './RunExecutionMetadata';
import { RuntimeNotice } from './RuntimeNotice';
import { ReleaseCommit } from './ReleaseCommit';
import { TaskExecutionFields } from './TaskExecutionFields';
import type { TaskOptions } from '../src/tasks/schemas';
import type { Connector } from './management';
import type { Conversation, ConversationDetail, ExecutionEvent, Message, Run, Status } from './types';

type View = 'chat' | 'projects' | 'repositories' | 'workers' | 'jobs' | 'connections' | 'memory' | 'skills' | 'artifacts';
const viewNames: Record<View, string> = { chat: 'Workspace', projects: 'Projects', repositories: 'Repositories', workers: 'Workers', jobs: 'Jobs', connections: 'Connections', memory: 'Memory', skills: 'Skills', artifacts: 'Artifacts' };
const activeStates = new Set<Run['status']>(['queued', 'running', 'waiting', 'uncertain']);
export const friendlyStatus = (status: Run['status']) => ({ waiting: 'Needs your input', queued: 'Queued', running: 'Working', completed: 'Completed', failed: 'Failed', interrupted: 'Interrupted', uncertain: 'Needs reconciliation' }[status]);
export function formatTime(date: string) { const value = new Date(date); return Number.isNaN(value.getTime()) ? '' : value.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); }
const appendUnique = <T extends { id: string }>(list: T[], value: T) => list.some(item => item.id === value.id) ? list.map(item => item.id === value.id ? value : item) : [...list, value];
async function workspaceRead<T>(path: string, signal: AbortSignal) {
  try { return await api<T>(path, { signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]) }); }
  catch (cause) { if (!signal.aborted) throw cause; }
}

export default function App() {
  const [authenticated, setAuthenticated] = useState<boolean | null>(null);
  const [error, setError] = useState('');
  const [view, setView] = useState<View>('chat');
  const [projectId, setProjectId] = useState<string | null>(null);
  const [connectorTarget, setConnectorTarget] = useState<string | null>(null);
  const [authorizationNotice, setAuthorizationNotice] = useState('');
  const [authorizationFailed, setAuthorizationFailed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [agentOpen, setAgentOpen] = useState(false);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const currentId = useRef<string | null>(null);
  const conversationRows = useRef<Conversation[]>([]);
  const removedConversations = useRef(new Set<string>());
  const conversationListRequest = useRef(0), conversationDetailRequest = useRef(0);
  const statusRequest = useRef(0);
  const workspaceRequests = useRef<AbortController | null>(null);
  const deletingConversation = useRef<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [detail, setDetail] = useState<ConversationDetail | null>(null);
  const [status, setStatus] = useState<Status | null>(null);
  const [streamConnected, setStreamConnected] = useState(false);
  const [busy, setBusy] = useState(false);
  const [prompt, setPrompt] = useState('');
  const [pendingRequest, setPendingRequest] = useState<{ prompt: string; requestId: string; options: TaskOptions } | null>(null);
  const [executionOptions, setExecutionOptions] = useState<TaskOptions>({ workerId: null, requiredRoot: false });
  const [taskConnectors, setTaskConnectors] = useState<Connector[]>([]);
  const [events, setEvents] = useState<ExecutionEvent[]>([]);
  const cursor = useRef(0);
  const bottom = useRef<HTMLDivElement>(null);
  const unsavedSource = useRef(false);
  const reportUnsavedSource = useCallback((dirty: boolean) => { unsavedSource.current = dirty; }, []);
  const canNavigate = () => {
    if (deletingConversation.current) return false;
    if (!unsavedSource.current) return true;
    return window.confirm('Discard unsaved source edits and leave this editor?');
  };

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const outcome = params.get('oauth'), target = params.get('connector');
    if ((outcome === 'connected' || outcome === 'error') && target && /^[0-9a-f-]{36}$/i.test(target)) {
      setConnectorTarget(target); setView('connections'); setAuthorizationFailed(outcome === 'error'); setAuthorizationNotice(outcome === 'connected' ? 'Account authorization completed. Check connection readiness below.' : 'Account authorization did not complete. Review the connection and try again.');
      window.history.replaceState(null, '', window.location.pathname);
    }
  }, []);

  useEffect(() => {
    let alive = true;
    const controller = new AbortController();
    api<{ authenticated: boolean; csrfToken?: string }>('/session', { signal: controller.signal }).then(session => {
      if (!alive) return;
      setCsrf(session.csrfToken || '');
      setAuthenticated(session.authenticated);
    }).catch(cause => { if (alive) { setError(cause.message); setAuthenticated(false); } });
    const unauthorized = () => { setAuthenticated(false); setCsrf(''); };
    window.addEventListener('operator:unauthorized', unauthorized);
    return () => { alive = false; controller.abort(); window.removeEventListener('operator:unauthorized', unauthorized); };
  }, []);

  useEffect(() => {
    if (!authenticated || view !== 'chat') return;
    let alive = true;
    void api<Connector[]>('/connectors').then(value => { if (alive) setTaskConnectors(value); }).catch(cause => { if (alive) setError(cause.message); });
    return () => { alive = false; };
  }, [authenticated, view]);

  const refreshStatus = useCallback(async () => {
    const controller = workspaceRequests.current;
    if (!controller) return;
    const request = ++statusRequest.current;
    const value = await workspaceRead<Status>('/status', controller.signal);
    if (value && !controller.signal.aborted && request === statusRequest.current) setStatus(value);
  }, []);
  const refreshConversations = useCallback(async () => {
    const controller = workspaceRequests.current;
    if (!controller) return;
    const request = ++conversationListRequest.current;
    const value = await workspaceRead<Conversation[]>('/conversations', controller.signal);
    if (!value || controller.signal.aborted || request !== conversationListRequest.current) return;
    const rows = asList(value).filter((conversation: Conversation) => !removedConversations.current.has(conversation.id));
    conversationRows.current = rows; setConversations(rows);
    if (!currentId.current && rows[0]) { currentId.current = rows[0].id; setConversationId(rows[0].id); }
  }, []);
  const loadConversation = useCallback(async (id: string) => {
    const controller = workspaceRequests.current;
    if (!controller) return;
    if (currentId.current !== id || removedConversations.current.has(id)) return;
    const request = ++conversationDetailRequest.current;
    try {
      const value = await workspaceRead<ConversationDetail>(`/conversations/${encodeURIComponent(id)}`, controller.signal);
      if (value && !controller.signal.aborted && currentId.current === id && request === conversationDetailRequest.current && !removedConversations.current.has(id)) {
        setDetail(value);
        setEvents(previous => {
          const map = new Map(previous.filter(event => !event.conversationId || !removedConversations.current.has(event.conversationId)).map(event => [event.seq, event]));
          for (const event of value.events || []) if (!event.conversationId || !removedConversations.current.has(event.conversationId)) map.set(event.seq, event);
          return [...map.values()].sort((a, b) => a.seq - b.seq);
        });
      }
    } catch (cause) { if (currentId.current === id && request === conversationDetailRequest.current && !removedConversations.current.has(id) && deletingConversation.current !== id) throw cause; }
  }, []);
  const removeConversationFromWorkspace = useCallback((id: string) => {
    if (removedConversations.current.has(id)) return;
    removedConversations.current.add(id);
    const remaining = conversationRows.current.filter(conversation => conversation.id !== id);
    conversationRows.current = remaining; setConversations(remaining);
    setEvents(previous => previous.filter(event => event.conversationId !== id));
    if (currentId.current === id) {
      const next = remaining[0]?.id ?? null;
      currentId.current = next; conversationDetailRequest.current++; setConversationId(next); setDetail(null);
      setPrompt(''); setPendingRequest(null); setExecutionOptions({ workerId: null, requiredRoot: false }); setMobileOpen(false); setError('');
    }
  }, []);

  useEffect(() => {
    if (!authenticated) return;
    let alive = true;
    const controller = new AbortController();
    workspaceRequests.current = controller;
    let initializing = true, refreshing = false, replaying = true, connectionOpen = false;
    let lastSnapshotAt: number | null = null;
    let pendingList = false, pendingDetail = false, pendingStatus = false;
    let refreshTimer: number | undefined, firstPendingAt = 0;
    const reportError = (cause: unknown) => { if (alive && !controller.signal.aborted) setError(cause instanceof Error ? cause.message : 'Could not refresh the workspace.'); };
    const flushRefresh = async () => {
      refreshTimer = undefined;
      if (!alive || initializing || refreshing) return;
      const list = pendingList, selectedDetail = pendingDetail, status = pendingStatus;
      pendingList = pendingDetail = pendingStatus = false; firstPendingAt = 0;
      refreshing = true;
      const requests = [
        ...(list ? [refreshConversations()] : []),
        ...(selectedDetail && currentId.current ? [loadConversation(currentId.current)] : []),
        ...(status ? [refreshStatus()] : []),
      ];
      const results = await Promise.allSettled(requests);
      for (const result of results) if (result.status === 'rejected') reportError(result.reason);
      refreshing = false;
      if (alive && (pendingList || pendingDetail || pendingStatus)) scheduleRefresh(false, false);
    };
    const scheduleRefresh = (list = true, selectedDetail = true, status = false) => {
      pendingList ||= list; pendingDetail ||= selectedDetail; pendingStatus ||= status;
      if (!firstPendingAt) firstPendingAt = Date.now();
      if (refreshTimer !== undefined) window.clearTimeout(refreshTimer);
      refreshTimer = window.setTimeout(() => { void flushRefresh(); }, Math.max(0, Math.min(150, 1000 - (Date.now() - firstPendingAt))));
    };
    const initialize = async () => {
      try {
        const results = await Promise.allSettled([refreshConversations(), refreshStatus()]);
        for (const result of results) if (result.status === 'rejected') reportError(result.reason);
      } finally {
        initializing = false;
        if (alive && (pendingList || pendingDetail || pendingStatus)) scheduleRefresh(false, false);
      }
    };
    void initialize();
    const interval = window.setInterval(() => {
      if (!connectionOpen || lastSnapshotAt === null || Date.now() - lastSnapshotAt > 30_000) {
        setStreamConnected(false);
        scheduleRefresh(true, true, true);
      }
    }, 5000);
    const source = new EventSource(`/api/events?after=${cursor.current}`, { withCredentials: true });
    source.onopen = () => { if (alive) { connectionOpen = true; replaying = true; } };
    source.onerror = () => { if (alive) { connectionOpen = false; replaying = true; lastSnapshotAt = null; setStreamConnected(false); } };
    source.addEventListener('event', event => {
      if (!alive) return;
      let value: ExecutionEvent;
      try { value = JSON.parse((event as MessageEvent).data); } catch { return; }
      if (typeof value.seq !== 'number' || value.seq <= cursor.current) return;
      cursor.current = value.seq;
      if (value.type === 'conversation_deleted' && typeof value.data?.conversationId === 'string') { removeConversationFromWorkspace(value.data.conversationId); return; }
      if (value.conversationId && removedConversations.current.has(value.conversationId)) return;
      setEvents(previous => previous.some(item => item.seq === value.seq) ? previous : [...previous, value]);
      if (!replaying && ['run', 'completed', 'thread', 'clarification'].includes(value.type)) scheduleRefresh(true, currentId.current === value.conversationId);
      if (value.type === 'message' && value.conversationId === currentId.current) {
        const message = value.data.message as Message | undefined;
        if (message) setDetail(previous => previous ? { ...previous, messages: appendUnique(previous.messages, message) } : previous);
      }
    });
    source.addEventListener('status', event => {
      if (!alive) return;
      try {
        const value = JSON.parse((event as MessageEvent).data);
        if (!value || typeof value !== 'object' || !('worker' in value) || !Array.isArray(value.queue)) return;
        statusRequest.current++; lastSnapshotAt = Date.now(); setStatus(value); setStreamConnected(true);
        pendingStatus = false;
        // The server sends its current status after replaying durable events.
        if (replaying) { replaying = false; scheduleRefresh(); }
      } catch { /* polling recovers if valid snapshots stop arriving */ }
    });
    return () => {
      alive = false; controller.abort(); source.close(); window.clearInterval(interval);
      if (refreshTimer !== undefined) window.clearTimeout(refreshTimer);
      if (workspaceRequests.current === controller) workspaceRequests.current = null;
      statusRequest.current++; conversationListRequest.current++; conversationDetailRequest.current++;
      setStreamConnected(false);
    };
  }, [authenticated, loadConversation, refreshConversations, refreshStatus, removeConversationFromWorkspace]);

  useEffect(() => {
    currentId.current = conversationId;
    setDetail(null);
    if (conversationId && authenticated) void loadConversation(conversationId).catch(cause => setError(cause.message));
  }, [conversationId, authenticated, loadConversation]);
  useEffect(() => { bottom.current?.scrollIntoView({ behavior: 'smooth', block: 'end' }); }, [detail?.messages.length, events.length]);

  const selectConversation = (id: string, discardConfirmed = false) => { if (deletingConversation.current || removedConversations.current.has(id) || !discardConfirmed && !canNavigate()) return; currentId.current = id; setConversationId(id); setView('chat'); setMobileOpen(false); setPrompt(''); setPendingRequest(null); setExecutionOptions({ workerId: null, requiredRoot: false }); };
  const newConversation = async () => {
    if (busy || !canNavigate()) return;
    setBusy(true);
    try {
      const value = await post<Conversation>('/conversations', {});
      if (removedConversations.current.has(value.id)) throw new Error('This conversation was deleted from the workspace. Create a new conversation to continue.');
      conversationListRequest.current++;
      conversationRows.current = [value, ...conversationRows.current];
      setConversations(previous => [value, ...previous]);
      selectConversation(value.id, true);
      void refreshConversations().catch(() => {});
    } catch (cause: any) { setError(cause.message); } finally { setBusy(false); }
  };
  const deleteConversation = async (conversation: Conversation) => {
    if (busy || deletingConversation.current || removedConversations.current.has(conversation.id)) return;
    if (!window.confirm(`Delete "${conversation.title || 'Untitled conversation'}" from your workspace?\n\nRecovery and execution records, saved memory, projects, files, and running services are kept.${currentId.current === conversation.id && prompt.trim() ? '\n\nThe unsent draft in this conversation will be discarded.' : ''}`)) return;
    deletingConversation.current = conversation.id; setDeletingId(conversation.id); setError('');
    try {
      await api(`/conversations/${encodeURIComponent(conversation.id)}`, { method: 'DELETE' });
      removeConversationFromWorkspace(conversation.id);
      void refreshConversations().catch(() => {});
    } catch (cause: any) { setError(cause.message); setMobileOpen(false); }
    finally { deletingConversation.current = null; setDeletingId(null); }
  };
  const submitPrompt = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!prompt.trim() || busy || deletingConversation.current || !document.querySelector<HTMLFormElement>('form.composer')?.reportValidity()) return;
    setBusy(true); setError('');
    let id = conversationId;
    const request = pendingRequest?.prompt === prompt.trim() && JSON.stringify(pendingRequest.options) === JSON.stringify(executionOptions) ? pendingRequest : { prompt: prompt.trim(), requestId: crypto.randomUUID(), options: { ...executionOptions } };
    setPendingRequest(request);
    try {
      if (!id) {
        const value = await post<Conversation>('/conversations', {});
        if (removedConversations.current.has(value.id)) throw new Error('This conversation was deleted before the task could be submitted. Create a new conversation to continue.');
        id = value.id;
        currentId.current = id; setConversationId(id);
        conversationListRequest.current++;
        conversationRows.current = [value, ...conversationRows.current];
        setConversations(previous => [value, ...previous]);
      }
      await post(`/conversations/${encodeURIComponent(id)}/runs`, { prompt: request.prompt, requestId: request.requestId, ...request.options });
      if (currentId.current === id) setPrompt(previous => previous.trim() === request.prompt ? '' : previous);
      setPendingRequest(previous => previous?.requestId === request.requestId ? null : previous);
      await Promise.all([loadConversation(id), refreshConversations(), refreshStatus()]);
    } catch (cause: any) { setError(cause.message); } finally { setBusy(false); }
  };
  const openRun = async (id: string) => {
    try {
      const run = await api<Run>(`/runs/${encodeURIComponent(id)}`);
      if (removedConversations.current.has(run.conversationId)) { setError('This conversation has been deleted from the workspace. Execution history is retained for recovery.'); return; }
      // Retained job/run history can outlive a conversation; verify it before leaving this view.
      await api<ConversationDetail>(`/conversations/${encodeURIComponent(run.conversationId)}`);
      if (!canNavigate() || removedConversations.current.has(run.conversationId)) return;
      selectConversation(run.conversationId, true);
      await loadConversation(run.conversationId);
    } catch (cause: any) { setError(cause.message); }
  };
  const runAction = async (runId: string, action: string, body = {}) => {
    try {
      await post(`/runs/${encodeURIComponent(runId)}/${action}`, body);
      await refreshStatus();
      if (currentId.current) await loadConversation(currentId.current);
    } catch (cause: any) { setError(cause.message); }
  };
  const logout = async () => {
    if (!canNavigate()) return;
    setBusy(true);
    try { await post('/logout'); setAuthenticated(false); setCsrf(''); setDetail(null); conversationListRequest.current++; conversationDetailRequest.current++; conversationRows.current = []; setConversations([]); setConversationId(null); currentId.current = null; setEvents([]); cursor.current = 0; } catch (cause: any) { setError(cause.message); } finally { setBusy(false); }
  };

  if (authenticated === null) return <div className="loading-page"><Brand /><span className="muted">Connecting to your workspace…</span></div>;
  if (!authenticated) return <Login initialError={error} onLogin={token => { setCsrf(token); setAuthenticated(true); setError(''); }} />;

  const worker = status?.worker;
  const connected = Boolean(worker);
  const executionUid = worker?.executionUid ?? worker?.uid;
  const rootWorker = Boolean(worker?.uid === 0 && worker.root && executionUid === 0);
  const workers = status?.workers ?? [];
  const poolMode = workers.some(value => value.worker.id !== 'default' || value.worker.mode === 'user');
  const readyWorkers = workers.filter(isWorkerReady);
  const agentConnected = poolMode ? workers.some(value => value.worker.enabled && !value.error && value.connected && value.health?.runtime.available && value.health.runtime.authenticated) : rootWorker && Boolean(worker?.runtime.available && worker.runtime.authenticated);
  const poolConnected = poolMode ? workers.some(value => value.connected) : connected;
  const selected = conversations.find(item => item.id === conversationId);
  const relevantEvents = events.filter(event => event.conversationId === conversationId);
  const runs = detail?.runs || [];
  const conversationActive = runs.filter(run => activeStates.has(run.status));
  const queue = status?.queue || [];
  const queuedCount = queue.filter(run => run.status === 'queued').length;
  const workerHealth = poolMode ? workers.flatMap(value => value.health ? [value.health] : []) : worker ? [worker] : [];
  const orphanExecutions = [...new Set(workerHealth.flatMap(value => value.uncertainRuns ?? []))].filter(id => !queue.some(run => run.id === id));
  const runtimeOperations = workerHealth.flatMap(value => value.runtimeOperations ?? []);
  const blockedTask = queue.find(run => run.status === 'queued' && run.blockedReason);
  const queueBlock = queuedCount === 0 ? null : status?.maintenance ? {
    title: 'Queue paused for maintenance',
    detail: 'Your tasks are saved. Execution will resume when maintenance finishes.',
  } : blockedTask ? {
    title: 'Queue waiting for task requirements',
    detail: `Your queued tasks are saved. ${blockedTask.blockedReason!}`,
  } : poolMode && readyWorkers.length === 0 ? {
    title: 'Queue waiting for workers',
    detail: 'Your tasks are saved. Start and connect an enabled user worker, or inspect the assigned worker’s blocked reason.',
  } : poolMode ? null : !worker ? {
    title: 'Queue paused: worker disconnected',
    detail: 'Connect your agent to start the root worker. Your queued tasks are saved.',
  } : !worker.runtime.available ? {
    title: 'Queue paused: Codex runtime unavailable',
    detail: worker.runtime.detail,
  } : !worker.runtime.authenticated ? {
    title: 'Queue paused: model authentication required',
    detail: worker.runtime.authenticating ? 'Finish signing in with ChatGPT. Your queued tasks will resume automatically when the agent connects.' : 'Connect your ChatGPT account to let the agent work. Your queued tasks will resume automatically.',
  } : worker.uncertainRuns?.length || queue.some(run => run.status === 'uncertain') ? {
    title: 'Queue paused: execution needs reconciliation',
    detail: 'Resolve the uncertain execution shown in the workspace before new tasks can start. Your queued tasks remain saved while execution is paused.',
  } : runtimeOperations.some(operation => operation.status === 'running') ? {
    title: 'Queue waiting for runtime operation',
    detail: 'Your tasks are saved. Execution will continue after the current runtime operation finishes.',
  } : null;

  const openWorkerSetup = () => { if (poolMode) { if (canNavigate()) setView('workers'); } else setAgentOpen(true); };

  return <div className="app-shell">
    {mobileOpen && <button className="sidebar-scrim" aria-label="Close navigation" onClick={() => setMobileOpen(false)} />}
    <aside className={`sidebar ${mobileOpen ? 'is-open' : ''}`}>
      <div className="sidebar-brand"><Brand /><span className="edition">LOCAL</span><button className="icon-button mobile-only" aria-label="Close navigation" onClick={() => setMobileOpen(false)}><Icon name="close" /></button></div>
      <button className="new-conversation" onClick={() => void newConversation()} disabled={busy || Boolean(deletingId)}><Icon name="plus" /><span>New conversation</span><kbd>+</kbd></button>
      <div className="nav-label">YOUR WORKSPACE</div>
      <nav className="primary-nav" aria-label="Workspace">
        {(['chat', 'projects', 'repositories', 'workers', 'jobs', 'connections', 'memory', 'skills', 'artifacts'] as View[]).map(item => <button key={item} className={view === item ? 'selected' : ''} disabled={Boolean(deletingId)} onClick={() => { if (view !== item && !canNavigate()) return; setView(item); setMobileOpen(false); }}><Icon name={item === 'chat' ? 'chat' : item === 'projects' ? 'layers' : item === 'repositories' ? 'code' : item === 'workers' ? 'terminal' : item === 'jobs' ? 'clock' : item === 'connections' ? 'link' : item === 'memory' ? 'brain' : item === 'skills' ? 'skill' : 'folder'} /><span>{item === 'chat' ? 'Conversations' : viewNames[item]}</span>{item === 'chat' && conversations.length > 0 && <span className="nav-count">{conversations.length}</span>}</button>)}
      </nav>
      <div className="conversation-heading"><span className="nav-label">RECENT CONVERSATIONS</span><Icon name="clock" size={13} /></div>
      <div className="conversation-list">
        {conversations.map(conversation => <div className="conversation-row" key={conversation.id}><button className={`conversation-link ${conversation.id === conversationId && view === 'chat' ? 'selected' : ''}`} disabled={Boolean(deletingId)} onClick={() => selectConversation(conversation.id)}><span className="conversation-dot" /><span>{conversation.title || 'Untitled conversation'}</span><Icon name="chevron" size={13} /></button><button className="icon-button conversation-delete" aria-label={`Delete conversation "${conversation.title || 'Untitled conversation'}"`} title={queue.some(run => run.conversationId === conversation.id && activeStates.has(run.status)) ? 'Finish or reconcile this conversation’s tasks before deleting it.' : 'Delete conversation'} disabled={busy || Boolean(deletingId) || queue.some(run => run.conversationId === conversation.id && activeStates.has(run.status))} onClick={() => void deleteConversation(conversation)}>{deletingId === conversation.id ? <span className="spinner" /> : <Icon name="trash" size={14} />}</button></div>)}
        {conversations.length === 0 && <p className="sidebar-empty">Your conversations will appear here.</p>}
      </div>
      <div className="sidebar-footer">
        <div className="host-card"><div className={`status-dot ${poolConnected ? 'ok' : ''}`} /><div><strong>{poolMode ? `${readyWorkers.length} workers ready` : connected ? 'Worker connected' : 'Worker disconnected'}</strong><span>{poolMode ? `${workers.length} registered · ${workers.filter(value => value.worker.enabled).length} enabled` : worker ? `${rootWorker ? 'Root mode' : 'Non-root mode'} · UID ${executionUid}` : 'Waiting for local worker'}</span></div><Icon name="terminal" size={17} /></div>
        <button className="logout" disabled={Boolean(deletingId)} onClick={() => void logout()}><span className="avatar">A</span><span>Administrator<small>Private workspace</small></span><Icon name="logout" size={17} /></button>
      </div>
    </aside>
    <main className="main-shell">
      <header className="topbar"><div className="breadcrumbs"><button className="icon-button mobile-only" aria-label="Open navigation" onClick={() => setMobileOpen(true)}><Icon name="menu" /></button><span>Operator</span><span className="slash">/</span><strong>{viewNames[view]}</strong></div><div className="topbar-right"><span className={`connection-label ${streamConnected ? 'connected' : ''}`}><span className="status-dot" />{streamConnected ? 'Live' : 'Reconnecting'}</span><span className={`privilege-pill ${!poolMode && rootWorker ? 'root-mode' : ''}`} title={poolMode ? 'Each task records its assigned worker and actual execution identity.' : worker ? `Worker process ${worker.pid}; actual execution UID ${executionUid}. Operator edits are discouraged by prompt instructions.` : 'No worker identity available'}><Icon name="terminal" size={13} />{poolMode ? `${readyWorkers.length}/${workers.length} ready` : worker ? `UID ${executionUid} · ${rootWorker ? 'root' : 'non-root'}` : 'No worker'}</span><button className={`agent-connect-button ${agentConnected ? 'is-connected' : ''}`} aria-haspopup={poolMode ? undefined : 'dialog'} aria-expanded={poolMode ? undefined : agentOpen} onClick={openWorkerSetup}><Icon name={agentConnected ? 'check' : 'link'} size={14} />{poolMode ? 'Manage workers' : agentConnected ? 'Agent connected' : worker?.runtime.authenticating ? 'Connecting agent…' : 'Connect agent'}</button></div></header>
      {error && <div className="error-banner" role="alert"><span>{error}</span><button className="icon-button" aria-label="Dismiss error" onClick={() => setError('')}><Icon name="close" size={16} /></button></div>}
      {queueBlock && <div className="runtime-notice" role="status" style={{ marginTop: 14 }}><Icon name="clock" size={17} /><span><strong>{queueBlock.title}</strong>{queueBlock.detail}{!agentConnected && !status?.maintenance && <button className="text-button agent-notice-action" onClick={openWorkerSetup}>{poolMode ? 'Manage workers' : 'Connect agent'}<Icon name="chevron" size={12} /></button>}</span></div>}
      {status?.maintenance && !queueBlock && <div className="notice-banner">Maintenance is active. Work and durable brain writes are paused for a consistent snapshot.</div>}
      <ExecutionRecovery orphanIds={orphanExecutions} operations={runtimeOperations} onResolve={(id, body) => runAction(id, 'resolve', body)} />
      {view === 'chat' ? <>
        <div className="conversation-top"><div><div className="eyebrow">CONVERSATION</div><h1>{selected?.title || 'A fresh start'}</h1></div><div className="model-tag"><span className={`status-dot ${worker?.runtime.authenticated ? 'ok' : ''}`} />{worker?.runtime.model || 'Codex'}<span className="muted">{worker?.runtime.version ? `v${worker.runtime.version.replace(/^.*?([\d.]+)$/, '$1')}` : 'app-server'}</span></div></div>
        {!agentConnected && !queueBlock && <div className="runtime-notice"><Icon name="terminal" size={17} /><span><strong>{poolMode ? 'Prepare a worker for your tasks' : worker?.runtime.authenticating ? 'Finish connecting your agent' : 'Connect your agent to get started'}</strong>{poolMode ? 'Use Workers to start, enable, or sign in a matching profile. Your queued tasks keep their requirements.' : rootWorker ? 'Sign in with ChatGPT to let your agent start working.' : 'Start a root worker and sign in with ChatGPT. Conversations and memory are ready.'}<button className="text-button agent-notice-action" onClick={openWorkerSetup}>{poolMode ? 'Manage workers' : 'Connect agent'}<Icon name="chevron" size={12} /></button></span></div>}
        <div className="chat-scroll" data-testid="chat-history">
          <div className="chat-content">
            {!detail?.messages.length && !runs.length ? <div className="empty-conversation"><div className="agent-emblem"><Icon name="skill" size={30} /></div><span className="eyebrow">YOUR MACHINE. YOUR OPERATOR.</span><h2>What should we build?</h2><p>Give your operator a goal. It can inspect your VPS, build applications, and remember what it learns.</p><div className="suggestion-grid">{[
              ['Inspect this machine', 'Inspect this machine and summarize the OS, available resources, and current execution identity.', 'terminal'],
              ['Remember something', 'Help me save a durable memory that I can retrieve in a fresh conversation.', 'brain'],
              ['Create a useful skill', 'Search existing skills, then create and validate a small report-generation skill with a deterministic helper and fixtures.', 'skill'],
            ].map(([title, text, icon]) => <button key={title} onClick={() => { setPrompt(text); document.getElementById('message-composer')?.focus(); }}><Icon name={icon as IconName} /><span>{title}</span><Icon name="chevron" size={14} /></button>)}</div><div className="empty-note"><span className="status-dot ok" />Durable by design. Closing this tab won’t stop a run.</div></div> : <>
              {(detail?.messages || []).map(message => <MessageView key={message.id} message={message} />)}
              {runs.filter(run => !detail?.messages.some(message => message.role === 'assistant' && message.runId === run.id)).map(run => {
                const deltas = relevantEvents.filter(event => event.runId === run.id && event.type === 'delta').map(event => String(event.data.text || '')).join('');
                return deltas ? <MessageView key={`stream-${run.id}`} message={{ id: run.id, conversationId: run.conversationId, runId: run.id, role: 'assistant', content: deltas, createdAt: run.startedAt || run.createdAt }} streaming={run.status === 'running'} /> : null;
              })}
              {runs.map(run => <RunView key={run.id} onOpenRun={openRun} run={run} events={relevantEvents.filter(event => event.runId === run.id)} onAction={runAction} />)}
            </>}
            <div ref={bottom} />
          </div>
        </div>
        <div className="composer-wrap">
          {queue.length > 0 && <details className="queue-panel"><summary><Icon name="clock" size={15} /><strong>{queue.length} {queue.length === 1 ? 'task' : 'tasks'}{queuedCount === queue.length ? ' queued' : ''}</strong><span>{queueBlock ? 'Execution paused' : poolMode ? 'One task per worker' : 'One execution at a time'}</span><Icon name="chevron" size={13} /></summary><div>{queue.map((run, index) => <div className="queue-item" key={run.id}><span className="queue-number">{index + 1}</span><button onClick={() => selectConversation(run.conversationId)}>{run.prompt || (run.kind === 'improvement' ? 'Improvement pass' : 'Task')}</button><span className={`task-badge ${run.status}`}>{friendlyStatus(run.status)}</span></div>)}</div></details>}
          <form className="composer" onSubmit={submitPrompt}><TaskExecutionFields value={executionOptions} onChange={setExecutionOptions} workers={workers} connectors={taskConnectors} disabled={busy || Boolean(deletingId)} compact /><label className="sr-only" htmlFor="message-composer">Message your operator</label><textarea id="message-composer" value={prompt} disabled={Boolean(deletingId)} onChange={event => setPrompt(event.target.value)} placeholder={conversationActive.length ? 'Add another goal to the queue…' : 'Give your operator a goal…'} rows={2} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void submitPrompt(event); } }} /><div className="composer-bottom"><span><Icon name="skill" size={14} />{status?.maintenance ? 'Maintenance mode' : 'Persistent memory & skills'}</span><button className="send-button" type="submit" disabled={!prompt.trim() || busy || Boolean(deletingId) || status?.maintenance} aria-label="Send message">{busy ? <span className="spinner" /> : <Icon name="arrow" size={18} />}</button></div></form>
          <p className="composer-caption">Commands run as the worker’s actual user. <span>Enter to send · Shift + Enter for a new line</span></p>
        </div>
      </> : view === 'projects' ? <ProjectsPanel workers={workers} navigationPending={busy || Boolean(deletingId)} onBeforeNavigate={canNavigate} onUnsavedSourceChange={reportUnsavedSource} initialProjectId={projectId} workerConnected={Boolean(worker)} onError={setError} onConversation={conversation => { if (removedConversations.current.has(conversation.id)) { setError('This conversation has been deleted from the workspace.'); return; } conversationListRequest.current++; conversationRows.current = appendUnique(conversationRows.current, conversation); setConversations(previous => appendUnique(previous, conversation)); selectConversation(conversation.id, true); void refreshConversations().catch(() => {}); }} onSelectConversation={selectConversation} /> : view === 'repositories' ? <RepositoriesPanel onError={setError} onProject={id => { if (!canNavigate()) return; setProjectId(id); setView('projects'); }} /> : view === 'workers' ? <WorkersPanel onError={setError} onChanged={refreshStatus} /> : view === 'jobs' ? <JobsPanel onError={setError} onRun={openRun} /> : view === 'connections' ? <ConnectionsPanel initialConnectorId={connectorTarget} authorizationNotice={authorizationNotice} authorizationFailed={authorizationFailed} onError={setError} onProject={id => { if (!canNavigate()) return; setProjectId(id); setView('projects'); }} /> : view === 'memory' ? <MemoryPanel onError={setError} /> : view === 'skills' ? <SkillsPanel onError={setError} /> : <ArtifactsPanel onError={setError} />}
      <footer className="app-footer" aria-label="Application version"><ReleaseCommit /></footer>
    </main>
    <AgentConnection open={agentOpen} onClose={() => setAgentOpen(false)} worker={worker} onStatusChanged={refreshStatus} />
  </div>;
}

function Brand() { return <div className="brand"><span className="brand-mark"><i /><i /><i /><i /></span><span>operator<span className="brand-period">.</span></span></div>; }
function Login({ onLogin, initialError }: { onLogin: (token: string) => void; initialError: string }) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState(initialError);
  const [busy, setBusy] = useState(false);
  const submit = async (event: React.FormEvent) => {
    event.preventDefault(); setBusy(true); setError('');
    try { const result = await post<{ csrfToken: string }>('/login', { password }); onLogin(result.csrfToken); } catch (cause: any) { setError(cause.message); } finally { setBusy(false); }
  };
  return <div className="login-page"><div className="login-brand"><Brand /><span className="edition">SELF-HOSTED</span></div><main className="login-card"><div className="login-symbol"><Icon name="terminal" size={28} /></div><div className="eyebrow">YOUR PRIVATE CONTROL ROOM</div><h1>Welcome back.</h1><p>Sign in to your operator workspace.</p><form onSubmit={submit}><label htmlFor="admin-password">Administrator password</label><input id="admin-password" type="password" value={password} onChange={event => setPassword(event.target.value)} required autoComplete="current-password" autoFocus placeholder="Enter your password" />{error && <div className="inline-error" role="alert">{error}</div>}<button className="primary-button" disabled={busy || !password} type="submit">{busy ? 'Signing in…' : 'Enter workspace'}<Icon name="arrow" size={17} style={{ transform: 'rotate(90deg)' }} /></button></form><div className="login-footnote"><span className="status-dot ok" />Local controller · authenticated session</div></main><footer>Your machine. Your memory. Your operator.<ReleaseCommit /></footer></div>;
}

function MessageView({ message, streaming }: { message: Message; streaming?: boolean }) {
  return <article className={`message ${message.role}`} data-testid={`message-${message.role}`}><div className={`message-avatar ${message.role}`}>{message.role === 'assistant' ? <Icon name="skill" size={16} /> : 'A'}</div><div className="message-main"><div className="message-meta"><strong>{message.role === 'assistant' ? 'Operator' : 'You'}</strong><time dateTime={message.createdAt}>{formatTime(message.createdAt)}</time>{streaming && <span className="streaming-label"><span className="status-dot ok" />Working</span>}</div><div className="message-content">{message.content}{streaming && <span className="text-cursor" />}</div></div></article>;
}

function RunView({ run, events, onAction, onOpenRun }: { run: Run; events: ExecutionEvent[]; onOpenRun: (id: string) => Promise<void>; onAction: (id: string, action: string, body?: any) => Promise<void> }) {
  const activity = events.filter(event => ['activity', 'checkpoint', 'status', 'thread', 'error', 'skills', 'tool', 'skill_discovery'].includes(event.type));
  const clarification = [...events].reverse().find(event => event.type === 'clarification');
  const waiting = run.status === 'waiting';
  const running = run.status === 'running' || waiting;
  return <div className="run-block" id={`run-${run.id}`}><div className="run-status-row"><span className={`task-badge ${run.status}`}><span className={`status-dot ${run.status === 'completed' ? 'ok' : ''}`} />{friendlyStatus(run.status)}</span><span className="run-kind">{run.kind === 'improvement' ? 'Improvement pass' : 'Task'} <code>{run.id.slice(0, 8)}</code></span>{running && <button className="subtle-button danger" onClick={() => void onAction(run.id, 'interrupt')}><Icon name="stop" size={12} />Interrupt</button>}{run.status === 'queued' && <button className="subtle-button" onClick={() => void onAction(run.id, 'interrupt')}>Cancel queued task</button>}</div><RunExecutionMetadata run={run} onOpenRun={onOpenRun} /><RuntimeNotice events={events} active={running} />{run.error && <p className="inline-error">{run.error}</p>}{run.status === 'uncertain' && <div className="uncertain-notice"><p>Inspect the host and affected external services before resolving this run. The worker checks only its recorded local process groups and terminates verified helpers or confirms their absence. External actions may already have happened; resolving does not verify or undo them. This task will not be retried.</p><button className="secondary-button danger" onClick={() => void onAction(run.id, 'resolve')}>Host inspected · resolve run</button></div>}{run.summary && <p className="checkpoint"><Icon name="check" size={14} />{run.summary}</p>}{activity.length > 0 && <details className="activity"><summary><Icon name="terminal" size={14} />Execution activity <span>{activity.length}</span><Icon name="chevron" size={13} /></summary><div className="activity-list">{activity.map(event => <ActivityEvent key={event.seq} event={event} />)}</div></details>}{waiting && clarification && <Clarification event={clarification} onReply={answers => onAction(run.id, 'reply', { requestId: clarification.data.requestId, answers })} />}{run.status === 'interrupted' && <p className="small-note">The task was interrupted. Deployed or deliberately detached services may continue independently.</p>}</div>;
}
function ActivityEvent({ event }: { event: ExecutionEvent }) {
  const data = event.data;
  const item = (data.item || data.params || data) as Record<string, any>;
  const command = item.command || item.name || item.type || data.method || event.type;
  const output = item.aggregatedOutput || item.output || item.result || item.delta;
  return <details className="activity-event"><summary><span className="activity-seq">{event.seq}</span><code>{typeof command === 'string' ? command : JSON.stringify(command)}</code><time>{formatTime(event.createdAt)}</time></summary><pre>{output ? typeof output === 'string' ? output : JSON.stringify(output, null, 2) : JSON.stringify(data, null, 2)}</pre></details>;
}
function Clarification({ event, onReply }: { event: ExecutionEvent; onReply: (answers: Record<string, { answers: string[] }>) => Promise<void> }) {
  const questions = (event.data.questions || []) as Array<{ id: string; header?: string; question: string; options?: Array<{ label: string; description?: string }> }>;
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const submit = async (formEvent: React.FormEvent) => { formEvent.preventDefault(); setBusy(true); try { await onReply(Object.fromEntries(questions.map(question => [question.id, { answers: [answers[question.id] || ''] }]))); } finally { setBusy(false); } };
  return <form className="clarification" onSubmit={submit}><div className="eyebrow">YOUR OPERATOR NEEDS INPUT</div>{questions.map(question => <fieldset key={question.id}><legend>{question.question}</legend>{question.options?.map(option => <label className="radio-option" key={option.label}><input type="radio" name={question.id} value={option.label} checked={answers[question.id] === option.label} onChange={() => setAnswers(previous => ({ ...previous, [question.id]: option.label }))} /><span><strong>{option.label}</strong>{option.description && <small>{option.description}</small>}</span></label>)}<label className="sr-only" htmlFor={`answer-${question.id}`}>Your answer: {question.question}</label><input id={`answer-${question.id}`} placeholder="Or enter your answer…" value={question.options?.some(option => option.label === answers[question.id]) ? '' : answers[question.id] || ''} onChange={input => setAnswers(previous => ({ ...previous, [question.id]: input.target.value }))} /></fieldset>)}<button className="primary-button" disabled={busy || questions.some(question => !answers[question.id]?.trim())}>Send answers<Icon name="arrow" size={14} /></button></form>;
}
