import { useCallback, useEffect, useRef, useState } from 'react';
import { api, asList, post, setCsrf } from './api';
import { Icon, type IconName } from './icons';
import { MemoryPanel, SkillsPanel, ArtifactsPanel } from './panels';
import { AgentConnection } from './AgentConnection';
import { ProjectsPanel } from './ProjectsPanel';
import type { Conversation, ConversationDetail, ExecutionEvent, Message, Run, Status } from './types';

type View = 'chat' | 'projects' | 'memory' | 'skills' | 'artifacts';
const viewNames: Record<View, string> = { chat: 'Workspace', projects: 'Projects', memory: 'Memory', skills: 'Skills', artifacts: 'Artifacts' };
const activeStates = new Set<Run['status']>(['queued', 'running', 'waiting', 'uncertain']);
export const friendlyStatus = (status: Run['status']) => ({ waiting: 'Needs your input', queued: 'Queued', running: 'Working', completed: 'Completed', failed: 'Failed', interrupted: 'Interrupted', uncertain: 'Needs reconciliation' }[status]);
export function formatTime(date: string) { const value = new Date(date); return Number.isNaN(value.getTime()) ? '' : value.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); }
const appendUnique = <T extends { id: string }>(list: T[], value: T) => list.some(item => item.id === value.id) ? list.map(item => item.id === value.id ? value : item) : [...list, value];

export default function App() {
  const [authenticated, setAuthenticated] = useState<boolean | null>(null);
  const [error, setError] = useState('');
  const [view, setView] = useState<View>('chat');
  const [mobileOpen, setMobileOpen] = useState(false);
  const [agentOpen, setAgentOpen] = useState(false);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const currentId = useRef<string | null>(null);
  const [detail, setDetail] = useState<ConversationDetail | null>(null);
  const [status, setStatus] = useState<Status | null>(null);
  const [streamConnected, setStreamConnected] = useState(false);
  const [busy, setBusy] = useState(false);
  const [prompt, setPrompt] = useState('');
  const [pendingRequest, setPendingRequest] = useState<{ prompt: string; requestId: string } | null>(null);
  const [events, setEvents] = useState<ExecutionEvent[]>([]);
  const cursor = useRef(0);
  const bottom = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let alive = true;
    api<{ authenticated: boolean; csrfToken?: string }>('/session').then(session => {
      if (!alive) return;
      setCsrf(session.csrfToken || '');
      setAuthenticated(session.authenticated);
    }).catch(cause => { if (alive) { setError(cause.message); setAuthenticated(false); } });
    const unauthorized = () => { setAuthenticated(false); setCsrf(''); };
    window.addEventListener('operator:unauthorized', unauthorized);
    return () => { alive = false; window.removeEventListener('operator:unauthorized', unauthorized); };
  }, []);

  const refreshStatus = useCallback(async () => {
    const value = await api<Status>('/status');
    setStatus(value);
  }, []);
  const refreshConversations = useCallback(async () => {
    const value = await api<Conversation[]>('/conversations');
    setConversations(asList(value));
  }, []);
  const loadConversation = useCallback(async (id: string) => {
    const value = await api<ConversationDetail>(`/conversations/${encodeURIComponent(id)}`);
    if (currentId.current === id) {
      setDetail(value);
      setEvents(previous => {
        const map = new Map(previous.map(event => [event.seq, event]));
        for (const event of value.events || []) map.set(event.seq, event);
        return [...map.values()].sort((a, b) => a.seq - b.seq);
      });
    }
  }, []);

  useEffect(() => {
    if (!authenticated) return;
    let alive = true;
    const initialize = async () => {
      try {
        const values = await api<Conversation[]>('/conversations');
        if (!alive) return;
        const rows = asList(values);
        setConversations(rows);
        if (!currentId.current && rows[0]) { currentId.current = rows[0].id; setConversationId(rows[0].id); }
        await refreshStatus();
      } catch (cause: any) { if (alive) setError(cause.message); }
    };
    void initialize();
    const interval = window.setInterval(() => { void refreshStatus().catch(cause => setError(cause.message)); }, 5000);
    const source = new EventSource(`/api/events?after=${cursor.current}`, { withCredentials: true });
    source.onopen = () => setStreamConnected(true);
    source.onerror = () => setStreamConnected(false);
    source.addEventListener('event', event => {
      let value: ExecutionEvent;
      try { value = JSON.parse((event as MessageEvent).data); } catch { return; }
      if (typeof value.seq !== 'number' || value.seq <= cursor.current) return;
      cursor.current = value.seq;
      setEvents(previous => previous.some(item => item.seq === value.seq) ? previous : [...previous, value]);
      if (value.type === 'run' || value.type === 'completed' || value.type === 'thread' || value.type === 'clarification') {
        void refreshStatus().catch(() => {});
        void refreshConversations().catch(() => {});
        if (currentId.current && currentId.current === value.conversationId) void loadConversation(currentId.current).catch(cause => setError(cause.message));
      }
      if (value.type === 'message' && value.conversationId === currentId.current) {
        const message = value.data.message as Message | undefined;
        if (message) setDetail(previous => previous ? { ...previous, messages: appendUnique(previous.messages, message) } : previous);
      }
    });
    source.addEventListener('status', event => {
      try { const value = JSON.parse((event as MessageEvent).data); if ('worker' in value) setStatus(value); } catch { /* reconnection will refresh state */ }
    });
    return () => { alive = false; source.close(); window.clearInterval(interval); setStreamConnected(false); };
  }, [authenticated, loadConversation, refreshConversations, refreshStatus]);

  useEffect(() => {
    currentId.current = conversationId;
    setDetail(null);
    if (conversationId && authenticated) void loadConversation(conversationId).catch(cause => setError(cause.message));
  }, [conversationId, authenticated, loadConversation]);
  useEffect(() => { bottom.current?.scrollIntoView({ behavior: 'smooth', block: 'end' }); }, [detail?.messages.length, events.length]);

  const selectConversation = (id: string) => { setConversationId(id); setView('chat'); setMobileOpen(false); setPrompt(''); setPendingRequest(null); };
  const newConversation = async () => {
    setBusy(true);
    try {
      const value = await post<Conversation>('/conversations', {});
      setConversations(previous => [value, ...previous]);
      selectConversation(value.id);
    } catch (cause: any) { setError(cause.message); } finally { setBusy(false); }
  };
  const submitPrompt = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!prompt.trim() || busy) return;
    setBusy(true); setError('');
    let id = conversationId;
    const request = pendingRequest?.prompt === prompt.trim() ? pendingRequest : { prompt: prompt.trim(), requestId: crypto.randomUUID() };
    setPendingRequest(request);
    try {
      if (!id) {
        const value = await post<Conversation>('/conversations', {});
        id = value.id;
        currentId.current = id; setConversationId(id);
        setConversations(previous => [value, ...previous]);
      }
      await post(`/conversations/${encodeURIComponent(id)}/runs`, request);
      if (currentId.current === id) setPrompt(previous => previous.trim() === request.prompt ? '' : previous);
      setPendingRequest(previous => previous?.requestId === request.requestId ? null : previous);
      await Promise.all([loadConversation(id), refreshConversations(), refreshStatus()]);
    } catch (cause: any) { setError(cause.message); } finally { setBusy(false); }
  };
  const runAction = async (runId: string, action: string, body = {}) => {
    try {
      await post(`/runs/${encodeURIComponent(runId)}/${action}`, body);
      await refreshStatus();
      if (currentId.current) await loadConversation(currentId.current);
    } catch (cause: any) { setError(cause.message); }
  };
  const logout = async () => {
    try { await post('/logout'); setAuthenticated(false); setCsrf(''); setDetail(null); setConversations([]); setConversationId(null); currentId.current = null; setEvents([]); cursor.current = 0; } catch (cause: any) { setError(cause.message); }
  };

  if (authenticated === null) return <div className="loading-page"><Brand /><span className="muted">Connecting to your workspace…</span></div>;
  if (!authenticated) return <Login initialError={error} onLogin={token => { setCsrf(token); setAuthenticated(true); setError(''); }} />;

  const worker = status?.worker;
  const connected = Boolean(worker);
  const executionUid = worker?.executionUid ?? worker?.uid;
  const rootWorker = Boolean(worker?.uid === 0 && worker.root && executionUid === 0);
  const agentConnected = rootWorker && Boolean(worker?.runtime.authenticated);
  const selected = conversations.find(item => item.id === conversationId);
  const relevantEvents = events.filter(event => event.conversationId === conversationId);
  const runs = detail?.runs || [];
  const conversationActive = runs.filter(run => activeStates.has(run.status));
  const queue = status?.queue || [];
  const queuedCount = queue.filter(run => run.status === 'queued').length;
  const orphanExecutions = (worker?.uncertainRuns || []).filter(id => !queue.some(run => run.id === id));
  const queueBlock = queuedCount === 0 ? null : status?.maintenance ? {
    title: 'Queue paused for maintenance',
    detail: 'Your tasks are saved. Execution will resume when maintenance finishes.',
  } : !worker ? {
    title: 'Queue paused: worker disconnected',
    detail: 'Connect your agent to start the root worker. Your queued tasks are saved.',
  } : !rootWorker ? {
    title: 'Queue paused: root worker required',
    detail: 'Start a worker running as UID 0 to resume your saved tasks.',
  } : !worker.runtime.available ? {
    title: 'Queue paused: Codex runtime unavailable',
    detail: worker.runtime.detail,
  } : !worker.runtime.authenticated ? {
    title: 'Queue paused: model authentication required',
    detail: worker.runtime.authenticating ? 'Finish signing in with ChatGPT. Your queued tasks will resume automatically when the agent connects.' : 'Connect your ChatGPT account to let the agent work. Your queued tasks will resume automatically.',
  } : worker.uncertainRuns?.length || queue.some(run => run.status === 'uncertain') ? {
    title: 'Queue paused: execution needs reconciliation',
    detail: 'Resolve the uncertain execution shown in the workspace before new tasks can start. Your queued tasks remain saved while execution is paused.',
  } : null;

  return <div className="app-shell">
    {mobileOpen && <button className="sidebar-scrim" aria-label="Close navigation" onClick={() => setMobileOpen(false)} />}
    <aside className={`sidebar ${mobileOpen ? 'is-open' : ''}`}>
      <div className="sidebar-brand"><Brand /><span className="edition">LOCAL</span><button className="icon-button mobile-only" aria-label="Close navigation" onClick={() => setMobileOpen(false)}><Icon name="close" /></button></div>
      <button className="new-conversation" onClick={() => void newConversation()} disabled={busy}><Icon name="plus" /><span>New conversation</span><kbd>+</kbd></button>
      <div className="nav-label">YOUR WORKSPACE</div>
      <nav className="primary-nav" aria-label="Workspace">
        {(['chat', 'projects', 'memory', 'skills', 'artifacts'] as View[]).map(item => <button key={item} className={view === item ? 'selected' : ''} onClick={() => { setView(item); setMobileOpen(false); }}><Icon name={item === 'chat' ? 'chat' : item === 'projects' ? 'layers' : item === 'memory' ? 'brain' : item === 'skills' ? 'skill' : 'folder'} /><span>{item === 'chat' ? 'Conversations' : viewNames[item]}</span>{item === 'chat' && conversations.length > 0 && <span className="nav-count">{conversations.length}</span>}</button>)}
      </nav>
      <div className="conversation-heading"><span className="nav-label">RECENT CONVERSATIONS</span><Icon name="clock" size={13} /></div>
      <div className="conversation-list">
        {conversations.map(conversation => <button key={conversation.id} className={`conversation-link ${conversation.id === conversationId && view === 'chat' ? 'selected' : ''}`} onClick={() => selectConversation(conversation.id)}><span className="conversation-dot" /><span>{conversation.title || 'Untitled conversation'}</span><Icon name="chevron" size={13} /></button>)}
        {conversations.length === 0 && <p className="sidebar-empty">Your conversations will appear here.</p>}
      </div>
      <div className="sidebar-footer">
        <div className="host-card"><div className={`status-dot ${connected ? 'ok' : ''}`} /><div><strong>{connected ? 'Worker connected' : 'Worker disconnected'}</strong><span>{worker ? `${rootWorker ? 'Root mode' : 'Non-root mode'} · UID ${executionUid}` : 'Waiting for local worker'}</span></div><Icon name="terminal" size={17} /></div>
        <button className="logout" onClick={() => void logout()}><span className="avatar">A</span><span>Administrator<small>Private workspace</small></span><Icon name="logout" size={17} /></button>
      </div>
    </aside>
    <main className="main-shell">
      <header className="topbar"><div className="breadcrumbs"><button className="icon-button mobile-only" aria-label="Open navigation" onClick={() => setMobileOpen(true)}><Icon name="menu" /></button><span>Operator</span><span className="slash">/</span><strong>{viewNames[view]}</strong></div><div className="topbar-right"><span className={`connection-label ${streamConnected ? 'connected' : ''}`}><span className="status-dot" />{streamConnected ? 'Live' : 'Reconnecting'}</span><span className={`privilege-pill ${rootWorker ? 'root-mode' : ''}`} title={worker ? `Worker process ${worker.pid}; actual execution UID ${executionUid}. Operator edits are discouraged by prompt instructions.` : 'No worker identity available'}><Icon name="terminal" size={13} />{worker ? `UID ${executionUid} · ${rootWorker ? 'root' : 'non-root'}` : 'No worker'}</span><button className={`agent-connect-button ${agentConnected ? 'is-connected' : ''}`} aria-haspopup="dialog" aria-expanded={agentOpen} onClick={() => setAgentOpen(true)}><Icon name={agentConnected ? 'check' : 'link'} size={14} />{agentConnected ? 'Agent connected' : worker?.runtime.authenticating ? 'Connecting agent…' : 'Connect agent'}</button></div></header>
      {error && <div className="error-banner" role="alert"><span>{error}</span><button className="icon-button" aria-label="Dismiss error" onClick={() => setError('')}><Icon name="close" size={16} /></button></div>}
      {queueBlock && <div className="runtime-notice" role="status" style={{ marginTop: 14 }}><Icon name="clock" size={17} /><span><strong>{queueBlock.title}</strong>{queueBlock.detail}{!agentConnected && !status?.maintenance && <button className="text-button agent-notice-action" onClick={() => setAgentOpen(true)}>Connect agent<Icon name="chevron" size={12} /></button>}</span></div>}
      {status?.maintenance && !queueBlock && <div className="notice-banner">Maintenance is active. Work and durable brain writes are paused for a consistent snapshot.</div>}
      {orphanExecutions.length > 0 && <div className="orphan-warning" role="status"><strong>Orphan execution needs reconciliation</strong><p>Inspect the host before resolving. A worker restart left a skill check or other owned execution uncertain. The queue stays paused until the worker terminates or confirms the absence of each owned process. Its actions will not be retried.</p>{orphanExecutions.map(id => <div className="orphan-execution" key={id}><code>{id}</code><button className="secondary-button danger" aria-label={`Host inspected, resolve orphan ${id}`} onClick={() => void runAction(id, 'resolve')}>Host inspected · resolve orphan</button></div>)}</div>}
      {view === 'chat' ? <>
        <div className="conversation-top"><div><div className="eyebrow">CONVERSATION</div><h1>{selected?.title || 'A fresh start'}</h1></div><div className="model-tag"><span className={`status-dot ${worker?.runtime.authenticated ? 'ok' : ''}`} />{worker?.runtime.model || 'Codex'}<span className="muted">{worker?.runtime.version ? `v${worker.runtime.version.replace(/^.*?([\d.]+)$/, '$1')}` : 'app-server'}</span></div></div>
        {!agentConnected && !queueBlock && <div className="runtime-notice"><Icon name="terminal" size={17} /><span><strong>{worker?.runtime.authenticating ? 'Finish connecting your agent' : 'Connect your agent to get started'}</strong>{rootWorker ? 'Sign in with ChatGPT to let your agent start working.' : 'Start a root worker and sign in with ChatGPT. Conversations and memory are ready.'}<button className="text-button agent-notice-action" onClick={() => setAgentOpen(true)}>Connect agent<Icon name="chevron" size={12} /></button></span></div>}
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
              {runs.map(run => <RunView key={run.id} run={run} events={relevantEvents.filter(event => event.runId === run.id)} onAction={runAction} />)}
            </>}
            <div ref={bottom} />
          </div>
        </div>
        <div className="composer-wrap">
          {queue.length > 0 && <details className="queue-panel"><summary><Icon name="clock" size={15} /><strong>{queue.length} {queue.length === 1 ? 'task' : 'tasks'}{queuedCount === queue.length ? ' queued' : ''}</strong><span>{queueBlock ? 'Execution paused' : 'One execution at a time'}</span><Icon name="chevron" size={13} /></summary><div>{queue.map((run, index) => <div className="queue-item" key={run.id}><span className="queue-number">{index + 1}</span><button onClick={() => selectConversation(run.conversationId)}>{run.prompt || (run.kind === 'improvement' ? 'Improvement pass' : 'Task')}</button><span className={`task-badge ${run.status}`}>{friendlyStatus(run.status)}</span></div>)}</div></details>}
          <form className="composer" onSubmit={submitPrompt}><label className="sr-only" htmlFor="message-composer">Message your operator</label><textarea id="message-composer" value={prompt} onChange={event => setPrompt(event.target.value)} placeholder={conversationActive.length ? 'Add another goal to the queue…' : 'Give your operator a goal…'} rows={2} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void submitPrompt(event); } }} /><div className="composer-bottom"><span><Icon name="skill" size={14} />{status?.maintenance ? 'Maintenance mode' : 'Persistent memory & skills'}</span><button className="send-button" type="submit" disabled={!prompt.trim() || busy || status?.maintenance} aria-label="Send message">{busy ? <span className="spinner" /> : <Icon name="arrow" size={18} />}</button></div></form>
          <p className="composer-caption">Commands run as the worker’s actual user. <span>Enter to send · Shift + Enter for a new line</span></p>
        </div>
      </> : view === 'projects' ? <ProjectsPanel workerConnected={Boolean(worker)} onError={setError} onConversation={conversation => { setConversations(previous => appendUnique(previous, conversation)); selectConversation(conversation.id); }} onSelectConversation={selectConversation} /> : view === 'memory' ? <MemoryPanel onError={setError} /> : view === 'skills' ? <SkillsPanel onError={setError} /> : <ArtifactsPanel onError={setError} />}
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
  return <div className="login-page"><div className="login-brand"><Brand /><span className="edition">SELF-HOSTED</span></div><main className="login-card"><div className="login-symbol"><Icon name="terminal" size={28} /></div><div className="eyebrow">YOUR PRIVATE CONTROL ROOM</div><h1>Welcome back.</h1><p>Sign in to your operator workspace.</p><form onSubmit={submit}><label htmlFor="admin-password">Administrator password</label><input id="admin-password" type="password" value={password} onChange={event => setPassword(event.target.value)} required autoComplete="current-password" autoFocus placeholder="Enter your password" />{error && <div className="inline-error" role="alert">{error}</div>}<button className="primary-button" disabled={busy || !password} type="submit">{busy ? 'Signing in…' : 'Enter workspace'}<Icon name="arrow" size={17} style={{ transform: 'rotate(90deg)' }} /></button></form><div className="login-footnote"><span className="status-dot ok" />Local controller · authenticated session</div></main><footer>Your machine. Your memory. Your operator.</footer></div>;
}

function MessageView({ message, streaming }: { message: Message; streaming?: boolean }) {
  return <article className={`message ${message.role}`} data-testid={`message-${message.role}`}><div className={`message-avatar ${message.role}`}>{message.role === 'assistant' ? <Icon name="skill" size={16} /> : 'A'}</div><div className="message-main"><div className="message-meta"><strong>{message.role === 'assistant' ? 'Operator' : 'You'}</strong><time dateTime={message.createdAt}>{formatTime(message.createdAt)}</time>{streaming && <span className="streaming-label"><span className="status-dot ok" />Working</span>}</div><div className="message-content">{message.content}{streaming && <span className="text-cursor" />}</div></div></article>;
}

function RunView({ run, events, onAction }: { run: Run; events: ExecutionEvent[]; onAction: (id: string, action: string, body?: any) => Promise<void> }) {
  const activity = events.filter(event => ['activity', 'checkpoint', 'status', 'thread', 'error', 'skills', 'tool', 'skill_discovery'].includes(event.type));
  const clarification = [...events].reverse().find(event => event.type === 'clarification');
  const waiting = run.status === 'waiting';
  const running = run.status === 'running' || waiting;
  return <div className="run-block"><div className="run-status-row"><span className={`task-badge ${run.status}`}><span className={`status-dot ${run.status === 'completed' ? 'ok' : ''}`} />{friendlyStatus(run.status)}</span><span className="run-kind">{run.kind === 'improvement' ? 'Improvement pass' : 'Task'} <code>{run.id.slice(0, 8)}</code></span>{running && <button className="subtle-button danger" onClick={() => void onAction(run.id, 'interrupt')}><Icon name="stop" size={12} />Interrupt</button>}{run.status === 'queued' && <button className="subtle-button" onClick={() => void onAction(run.id, 'interrupt')}>Cancel queued task</button>}</div>{run.error && <p className="inline-error">{run.error}</p>}{run.status === 'uncertain' && <div className="uncertain-notice"><p>Inspect the host before resolving this run. The worker will terminate or confirm the absence of its owned orphan execution and release the queue. This task will not be retried.</p><button className="secondary-button danger" onClick={() => void onAction(run.id, 'resolve')}>Host inspected · resolve run</button></div>}{run.summary && <p className="checkpoint"><Icon name="check" size={14} />{run.summary}</p>}{activity.length > 0 && <details className="activity"><summary><Icon name="terminal" size={14} />Execution activity <span>{activity.length}</span><Icon name="chevron" size={13} /></summary><div className="activity-list">{activity.map(event => <ActivityEvent key={event.seq} event={event} />)}</div></details>}{waiting && clarification && <Clarification event={clarification} onReply={answers => onAction(run.id, 'reply', { requestId: clarification.data.requestId, answers })} />}{run.status === 'interrupted' && <p className="small-note">The task was interrupted. Deployed or deliberately detached services may continue independently.</p>}</div>;
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
