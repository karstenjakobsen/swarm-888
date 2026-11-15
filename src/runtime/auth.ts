import { AgentConnectionSchema, type AgentConnection } from '../agent-connection-schema.js';
import type { CodexAdapter } from './codex.js';

type RuntimeHealth = { authenticated: boolean; detail: string };
type LoginCompleted = { loginId: string | null; success: boolean; error: string | null };
type Outcome = { state: 'connected' | 'disconnected' | 'error'; error?: string; health?: RuntimeHealth };
type Session = {
  adapter: CodexAdapter;
  start: Promise<void>;
  loginId?: string;
  timer?: NodeJS.Timeout;
  early: Map<string, LoginCompleted>;
  done: boolean;
  verifying: boolean;
  finishing?: Promise<void>;
  cleanupFailed?: boolean;
};
export type AgentAuthenticatorOptions = {
  timeoutMs?: number;
  beforeStart?: () => Promise<void>;
  changed?: (connection: AgentConnection, busy: boolean, health?: RuntimeHealth) => void;
};

/** Transient, worker-owned login. No credentials or login events enter the run journal. */
export class AgentAuthenticator {
  private session?: Session;
  private connection: AgentConnection = this.view('disconnected');
  constructor(private factory: () => CodexAdapter, private options: AgentAuthenticatorOptions = {}) {}

  get busy(): boolean { return this.session !== undefined; }
  status(authenticated: boolean): AgentConnection {
    if (this.session) return { ...this.connection };
    if (authenticated) return this.view('connected');
    if (this.connection.state === 'error') return { ...this.connection };
    return this.view(authenticated ? 'connected' : 'disconnected');
  }
  connect(): Promise<AgentConnection> {
    if (this.session) return this.session.start.then(() => ({ ...this.connection }));
    const session: Session = { adapter: this.factory(), start: Promise.resolve(), early: new Map(), done: false, verifying: false };
    this.session = session;
    // Install handlers before initialize/login/start: a completion may precede its reply.
    session.adapter.on('loginCompleted', (event: LoginCompleted) => {
      if (session.done || event.loginId === null) return;
      if (!session.loginId) {
        if (session.early.size < 8) session.early.set(event.loginId, event);
      } else if (event.loginId === session.loginId) void this.complete(session, event);
    });
    session.adapter.on('fault', () => { if (!session.done) void this.finish(session, { state: 'error', error: 'The agent connection failed. Connect again to try ChatGPT sign-in.' }); });
    session.adapter.on('exit', () => { if (!session.done) void this.finish(session, { state: 'error', error: 'The agent disconnected during ChatGPT sign-in. Connect again to try again.' }); });
    this.connection = this.view('connecting'); this.changed();
    session.start = Promise.resolve().then(() => this.begin(session));
    return session.start.then(() => ({ ...this.connection }));
  }
  async cancel(authenticated: boolean): Promise<AgentConnection> {
    const session = this.session;
    if (session) {
      if (session.cleanupFailed) { session.finishing = undefined; session.cleanupFailed = false; }
      await this.finish(session, { state: 'disconnected' });
    } else { this.connection = this.view(authenticated ? 'connected' : 'disconnected'); this.changed(); }
    return { ...this.connection };
  }
  async close(): Promise<void> {
    await this.cancel(false);
    if (this.session) throw new Error('Unable to stop the owned ChatGPT sign-in process; worker shutdown requires host reconciliation');
  }
  private async begin(session: Session): Promise<void> {
    try {
      await this.options.beforeStart?.();
      if (session.done) return;
      await session.adapter.start();
      if (session.done) return;
      const health = await session.adapter.health(true);
      if (session.done) return;
      if (health.authenticated) { await this.finish(session, { state: 'connected', health }); return; }
      const login = await session.adapter.startDeviceLogin();
      session.loginId = login.loginId;
      if (session.done) return;
      if (!AgentConnectionSchema.shape.verificationUrl.safeParse(login.verificationUrl).success || !AgentConnectionSchema.shape.userCode.safeParse(login.userCode).success) {
        await this.finish(session, { state: 'error', error: 'ChatGPT returned an unexpected verification address or code. The connection was canceled.' }); return;
      }
      const timeoutMs = this.options.timeoutMs ?? 15 * 60_000;
      this.connection = { ...this.view('connecting'), verificationUrl: login.verificationUrl, userCode: login.userCode, expiresAt: new Date(Date.now() + timeoutMs).toISOString() };
      session.timer = setTimeout(() => void this.finish(session, { state: 'error', error: 'ChatGPT sign-in expired. Connect again to get a new code.' }), timeoutMs);
      this.changed();
      const completed = session.early.get(login.loginId); session.early.clear();
      if (completed) await this.complete(session, completed);
    } catch {
      if (!session.done) await this.finish(session, { state: 'error', error: 'Unable to start ChatGPT sign-in. Check that the worker can reach auth.openai.com and try again.' });
      else await session.finishing;
    }
  }
  private async complete(session: Session, event: LoginCompleted): Promise<void> {
    if (session.done || session.verifying) return;
    session.verifying = true;
    if (!event.success) {
      const error = /expir|timed out/i.test(event.error ?? '') ? 'ChatGPT sign-in expired. Connect again to get a new code.' : /cancel/i.test(event.error ?? '') ? 'ChatGPT sign-in was canceled. Connect again to try again.' : 'ChatGPT sign-in failed. Connect again to try again.';
      await this.finish(session, { state: 'error', error }); return;
    }
    try {
      const health = await session.adapter.health(true);
      if (session.done) return;
      if (!health.authenticated) throw new Error('Sign-in completion did not authenticate the application Codex profile');
      await this.finish(session, { state: 'connected', health });
    } catch {
      if (!session.done) await this.finish(session, { state: 'error', error: 'ChatGPT sign-in could not be verified. Connect again to try again.' });
    }
  }
  private finish(session: Session, outcome: Outcome): Promise<void> {
    if (session.finishing) return session.finishing;
    session.done = true; clearTimeout(session.timer); session.early.clear();
    // Remove the one-time code immediately, including while cancellation is in flight.
    this.connection = { ...this.view(outcome.state === 'connected' ? 'connecting' : outcome.state), ...(outcome.error ? { error: outcome.error } : {}) };
    this.changed();
    session.finishing = Promise.resolve().then(async () => {
      if (session.loginId && outcome.state !== 'connected') {
        try { await session.adapter.cancelDeviceLogin(session.loginId); } catch { /* Closing the poller is still required if the upstream cancellation failed. */ }
      }
      try { await session.adapter.close(); }
      catch {
        session.cleanupFailed = true;
        this.connection = { ...this.view('error'), error: 'The sign-in process could not be stopped. Restart the worker after checking its owned processes.' };
        this.changed(); return;
      }
      if (this.session === session) this.session = undefined;
      this.connection = { ...this.view(outcome.state), ...(outcome.error ? { error: outcome.error } : {}) };
      this.changed(outcome.health);
    });
    return session.finishing;
  }
  private view(state: AgentConnection['state']): AgentConnection { return { state, workerConnected: true, workerUid: process.getuid?.() ?? null }; }
  private changed(health?: RuntimeHealth): void { this.options.changed?.({ ...this.connection }, this.busy, health); }
}
