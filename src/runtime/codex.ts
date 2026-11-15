import { EventEmitter } from 'node:events';
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import type { Config } from '../config.js';
import type { Submission } from '../ipc.js';
import type { InitializeParams } from './generated/InitializeParams.js';
import type { ThreadStartParams } from './generated/v2/ThreadStartParams.js';
import type { ThreadResumeParams } from './generated/v2/ThreadResumeParams.js';
import type { TurnStartParams } from './generated/v2/TurnStartParams.js';
import type { LoginAccountParams } from './generated/v2/LoginAccountParams.js';
import type { LoginAccountResponse } from './generated/v2/LoginAccountResponse.js';
import type { CancelLoginAccountParams } from './generated/v2/CancelLoginAccountParams.js';
import type { CancelLoginAccountResponse } from './generated/v2/CancelLoginAccountResponse.js';
import type { AccountLoginCompletedNotification } from './generated/v2/AccountLoginCompletedNotification.js';
import { terminateGroup } from './processes.js';

export const CODEX_VERSION = '0.166.0';
const envelope = z.object({ id: z.union([z.number(), z.string()]).optional(), method: z.string().optional(), params: z.unknown().optional(), result: z.unknown().optional(), error: z.object({ code: z.number(), message: z.string() }).passthrough().optional() });
const threadResponse = z.object({ thread: z.object({ id: z.string() }).passthrough(), approvalPolicy: z.unknown(), sandbox: z.object({ type: z.string() }).passthrough(), model: z.string() }).passthrough();
export const deltaSchema = z.object({ threadId: z.string(), turnId: z.string(), itemId: z.string(), delta: z.string() });
export const turnCompletedSchema = z.object({ threadId: z.string(), turn: z.object({ id: z.string(), status: z.enum(['completed', 'interrupted', 'failed', 'inProgress']), error: z.unknown().nullable().optional() }).passthrough() });
const loginCompletedSchema = z.object({ loginId: z.string().nullable(), success: z.boolean(), error: z.string().nullable() }) satisfies z.ZodType<Pick<AccountLoginCompletedNotification, 'loginId' | 'success' | 'error'>>;
export type DeviceLogin = Extract<LoginAccountResponse, { type: 'chatgptDeviceCode' }>;
const clarificationSchema = z.object({ threadId: z.string(), turnId: z.string(), itemId: z.string(), questions: z.array(z.object({ id: z.string(), question: z.string(), header: z.string(), isSecret: z.boolean().optional(), options: z.array(z.object({ label: z.string(), description: z.string() })).nullable().optional() }).passthrough()) }).passthrough();

export function runtimeEnvironment(config: Config, runId?: string): NodeJS.ProcessEnv {
  return { ...process.env, CODEX_HOME: resolve(config.stateDir, 'runtime'), APP_STATE_DIR: config.stateDir,
    APP_BRIDGE_SOCKET: resolve(config.stateDir, 'bridge.sock'), APP_BRIDGE_TOKEN: config.ipcToken,
    OPERATOR_RUN_ID: runId ?? '', CODEX_DISABLE_UPDATE_CHECK: '1' };
}

/** All runtime-specific protocol and experimental clarification handling stays here. */
export class CodexAdapter extends EventEmitter {
  process?: ChildProcessWithoutNullStreams;
  private serial = 0;
  private pending = new Map<number, { resolve: (result: any) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  private requests = new Map<string, { id: number | string; method: string }>();
  private buffer = '';
  private shuttingDown = false;
  private improvement?: { limit: number; observed: Set<string>; interrupted: boolean; interruptSent: boolean };
  threadId?: string;
  turnId?: string;
  version = '';
  constructor(private config: Config, private runId?: string) { super(); }

  async start(): Promise<void> {
    mkdirSync(resolve(this.config.stateDir, 'runtime'), { recursive: true, mode: 0o700 });
    const version = spawnSync(this.config.codexBin, ['--version'], { env: runtimeEnvironment(this.config), encoding: 'utf8', timeout: 10_000 });
    if (version.error) throw new Error(`Codex executable unavailable: ${version.error.message}. Run npm ci.`);
    this.version = version.stdout.trim().replace(/^codex-cli\s+/, '');
    if (version.status !== 0 || this.version !== CODEX_VERSION) throw new Error(`Codex ${CODEX_VERSION} required; executable reports ${this.version || 'unknown'}`);
    const require = createRequire(import.meta.url);
    const mcpScript = resolve(import.meta.dirname, '../mcp.ts');
    const loader = require.resolve('tsx');
    const args = ['app-server', '--listen', 'stdio://',
      '-c', 'approval_policy="never"', '-c', 'sandbox_mode="danger-full-access"',
      '-c', `mcp_servers.operator.command=${JSON.stringify(process.execPath)}`,
      '-c', `mcp_servers.operator.args=${JSON.stringify(['--import', loader, mcpScript])}`,
      '-c', `mcp_servers.operator.env_vars=${JSON.stringify(['APP_STATE_DIR', 'APP_BRIDGE_SOCKET', 'APP_BRIDGE_TOKEN', 'OPERATOR_RUN_ID', ...(process.env.LD_LIBRARY_PATH ? ['LD_LIBRARY_PATH'] : [])])}`,
      '-c', 'mcp_servers.operator.startup_timeout_sec=20', '-c', 'mcp_servers.operator.tool_timeout_sec=600',
    ];
    const child = spawn(this.config.codexBin, args, { env: runtimeEnvironment(this.config, this.runId), stdio: 'pipe', detached: true });
    this.process = child;
    child.once('spawn', () => this.emit('spawn', { pid: child.pid! }));
    child.stdout.setEncoding('utf8'); child.stdout.on('data', (chunk: string) => this.consume(chunk));
    // stderr can include credentials/configuration from an upstream provider. Never persist it.
    child.stderr.resume();
    child.on('error', error => this.fail(error));
    child.on('exit', (code, signal) => {
      this.rejectPending(new Error(`Codex app-server exited (${signal ?? code})`));
      if (!this.shuttingDown) this.emit('exit', { code, signal });
    });
    const init: InitializeParams = { clientInfo: { name: 'vps_ai_operator', title: 'VPS AI Operator', version: '0.1.0' }, capabilities: { experimentalApi: true, requestAttestation: false } };
    await this.request('initialize', init);
    this.send({ method: 'initialized', params: {} });
  }

  async health(refreshToken = false): Promise<{ authenticated: boolean; detail: string }> {
    const result = z.object({ account: z.unknown().nullable(), requiresOpenaiAuth: z.boolean() }).parse(await this.request('account/read', { refreshToken }));
    const authenticated = result.account !== null || !result.requiresOpenaiAuth;
    return { authenticated, detail: authenticated ? 'Codex authentication configured' : 'Model authentication missing. Connect the agent in the web interface to sign in with ChatGPT.' };
  }

  async startDeviceLogin(): Promise<DeviceLogin> {
    const params: LoginAccountParams = { type: 'chatgptDeviceCode' };
    return z.object({ type: z.literal('chatgptDeviceCode'), loginId: z.string().min(1), verificationUrl: z.string(), userCode: z.string().min(1).max(100) }).parse(await this.request('account/login/start', params));
  }
  async cancelDeviceLogin(loginId: string): Promise<CancelLoginAccountResponse> {
    const params: CancelLoginAccountParams = { loginId };
    return z.object({ status: z.enum(['canceled', 'notFound']) }).parse(await this.request('account/login/cancel', params));
  }

  async run(submission: Submission): Promise<void> {
    this.turnId = undefined;
    this.improvement = submission.kind === 'improvement' ? { limit: this.config.improvementMaxTurns, observed: new Set(), interrupted: false, interruptSent: false } : undefined;
    const shared: ThreadStartParams = { cwd: submission.cwd, approvalPolicy: 'never', sandbox: 'danger-full-access', developerInstructions: submission.bootstrap, ...(this.config.model ? { model: this.config.model } : {}) };
    const response = threadResponse.parse(await this.request(submission.threadId ? 'thread/resume' : 'thread/start', submission.threadId ? { ...shared, threadId: submission.threadId } satisfies ThreadResumeParams : shared));
    if (response.approvalPolicy !== 'never' || response.sandbox.type !== 'dangerFullAccess') throw new Error('Runtime policy did not grant requested never/danger-full-access execution; no turn was started');
    this.threadId = response.thread.id;
    this.emit('event', 'thread', { threadId: this.threadId, model: response.model, approvalPolicy: response.approvalPolicy, sandbox: response.sandbox });
    const discovered = z.object({ data: z.array(z.object({ skills: z.array(z.object({ name: z.string(), path: z.string(), enabled: z.boolean() }).passthrough()), errors: z.array(z.unknown()) })) }).parse(await this.request('skills/list', { cwds: [submission.cwd], forceReload: true }));
    const all = discovered.data.flatMap(entry => entry.skills);
    const loaded = submission.skills.map(skill => {
      const match = all.find(candidate => candidate.name === skill.name && candidate.enabled && (candidate.path === resolve(submission.cwd, '.agents/skills', skill.name, 'SKILL.md') || candidate.path === resolve(skill.path, 'SKILL.md')));
      if (!match) throw new Error(`Published skill ${skill.name}@${skill.version} was not discovered by Codex`);
      return { ...skill, runtimePath: match.path };
    });
    this.emit('event', 'skills', { loaded, errors: discovered.data.flatMap(entry => entry.errors) });
    const params: TurnStartParams = { threadId: this.threadId, input: [{ type: 'text', text: submission.prompt, text_elements: [] }], approvalPolicy: 'never', sandboxPolicy: { type: 'dangerFullAccess' } };
    const turn = z.object({ turn: z.object({ id: z.string() }) }).parse(await this.request('turn/start', params));
    this.turnId = turn.turn.id;
    this.emit('event', 'status', { status: 'running', turnId: this.turnId });
    if (this.improvement?.interrupted && !this.improvement.interruptSent) { this.improvement.interruptSent = true; await this.interrupt(); }
  }

  async interrupt(): Promise<void> {
    if (!this.threadId || !this.turnId) throw new Error('Runtime turn has not started; interruption pending');
    await this.request('turn/interrupt', { threadId: this.threadId, turnId: this.turnId });
  }
  reply(requestId: string, answers: unknown): void {
    const req = this.requests.get(requestId); if (!req) throw new Error('Clarification request is no longer pending');
    let result: unknown;
    if (req.method === 'item/tool/requestUserInput') {
      const parsed = z.record(z.string(), z.union([z.string(), z.array(z.string()), z.object({ answers: z.array(z.string()) })])).parse(answers);
      result = { answers: Object.fromEntries(Object.entries(parsed).map(([key, value]) => [key, { answers: typeof value === 'string' ? [value] : Array.isArray(value) ? value : value.answers }])) };
    } else result = { action: 'accept', content: answers, _meta: null };
    this.requests.delete(requestId); this.send({ id: req.id, result });
    this.emit('event', 'status', { status: 'running' });
  }
  private consume(chunk: string): void {
    this.buffer += chunk;
    if (Buffer.byteLength(this.buffer) > 16 * 1024 * 1024) { this.fail(new Error('Codex protocol message exceeded 16 MiB')); return; }
    let newline: number;
    while ((newline = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, newline); this.buffer = this.buffer.slice(newline + 1);
      if (!line.trim()) continue;
      try { this.handle(envelope.parse(JSON.parse(line))); } catch (error) { this.fail(new Error(`Invalid Codex protocol message: ${error instanceof Error ? error.message.slice(0, 200) : 'invalid schema'}`)); return; }
    }
  }
  private handle(frame: z.infer<typeof envelope>): void {
    if (frame.id !== undefined && !frame.method) {
      const pending = this.pending.get(Number(frame.id)); if (!pending) return;
      clearTimeout(pending.timer); this.pending.delete(Number(frame.id));
      if (frame.error) pending.reject(new Error(frame.error.message)); else pending.resolve(frame.result);
      return;
    }
    if (!frame.method) return;
    // Authentication is observed separately and can never enter a run's journal.
    if (frame.id === undefined && frame.method === 'account/login/completed') {
      this.emit('loginCompleted', loginCompletedSchema.parse(frame.params)); return;
    }
    if (frame.id !== undefined) {
      if (frame.method === 'item/tool/requestUserInput') {
        const params = clarificationSchema.parse(frame.params);
        if (params.questions.some(question => question.isSecret)) { this.send({ id: frame.id, error: { code: -32602, message: 'Secrets must be configured server-side; do not request them through chat' } }); return; }
        const requestId = String(frame.id); this.requests.set(requestId, { id: frame.id, method: frame.method });
        this.emit('event', 'clarification', { requestId, questions: params.questions }); return;
      }
      if (frame.method === 'mcpServer/elicitation/request') {
        const params = z.object({ message: z.string(), mode: z.string(), requestedSchema: z.unknown().optional() }).passthrough().parse(frame.params);
        const requestId = String(frame.id); this.requests.set(requestId, { id: frame.id, method: frame.method });
        this.emit('event', 'clarification', { requestId, questions: [{ id: 'response', question: params.message, header: 'Tool input', requestedSchema: params.requestedSchema }] }); return;
      }
      // The requested full-access/never policy should not ask for routine approvals.
      this.send({ id: frame.id, error: { code: -32601, message: 'Unexpected runtime request under unrestricted execution configuration' } });
      this.emit('event', 'activity', { method: frame.method, error: 'Runtime requested an unsupported permission/auth interaction. Check host policy and server-side credentials.' }); return;
    }
    if (frame.method === 'item/agentMessage/delta') {
      const params = deltaSchema.parse(frame.params); this.emit('event', 'delta', { text: params.delta, itemId: params.itemId }); return;
    }
    if (frame.method === 'turn/started') {
      const params = z.object({ turn: z.object({ id: z.string() }) }).parse(frame.params); this.turnId = params.turn.id;
    }
    if (frame.method === 'item/started' && this.improvement && !this.improvement.interrupted) {
      const params = z.object({ item: z.object({ id: z.string(), type: z.string() }).passthrough() }).passthrough().parse(frame.params);
      if (!['agentMessage', 'userMessage', 'reasoning', 'plan'].includes(params.item.type)) {
        this.improvement.observed.add(params.item.id);
        if (this.improvement.observed.size >= this.improvement.limit) {
          this.improvement.interrupted = true;
          this.emit('event', 'activity', { method: 'operator/improvementBudget', limit: this.improvement.limit, observed: this.improvement.observed.size, reason: 'Observed tool-call budget reached; interrupting the separate improvement turn' });
          if (this.turnId) { this.improvement.interruptSent = true; void this.interrupt().catch(error => this.emit('fault', error)); }
        }
      }
    }
    if (frame.method === 'turn/completed') {
      const params = turnCompletedSchema.parse(frame.params);
      if (params.turn.status === 'inProgress') throw new Error('Completed notification contains in-progress turn');
      this.emit('event', 'completed', { status: params.turn.status, ...(params.turn.error ? { error: params.turn.error } : {}) }); return;
    }
    // Account/config events are intentionally excluded from execution records.
    if (/^(item\/|turn\/|thread\/tokenUsage)/.test(frame.method)) this.emit('event', 'activity', { method: frame.method, ...(frame.params && typeof frame.params === 'object' ? frame.params : {}) });
  }
  request(method: string, params: unknown): Promise<any> {
    const id = ++this.serial;
    return new Promise((resolveResult, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Codex ${method} timed out`)); }, 30_000);
      this.pending.set(id, { resolve: resolveResult, reject, timer });
      try { this.send({ id, method, params }); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }
  private send(frame: unknown): void { if (!this.process?.stdin.writable) throw new Error('Codex app-server is not connected'); this.process.stdin.write(JSON.stringify(frame) + '\n'); }
  private rejectPending(error: Error): void { for (const request of this.pending.values()) { clearTimeout(request.timer); request.reject(error); } this.pending.clear(); }
  private fail(error: Error): void { this.rejectPending(error); this.emit('fault', error); }
  async close(): Promise<void> {
    this.shuttingDown = true; this.requests.clear(); this.rejectPending(new Error('Codex adapter closed'));
    const child = this.process; if (!child?.pid) return;
    const pid = child.pid;
    // Wait for every member of the owned session, even if the app-server leader
    // already exited. A deliberately detached deployment has a different group.
    await terminateGroup(pid);
    if (child.exitCode === null && child.signalCode === null) await new Promise<void>(resolveExit => { const timer = setTimeout(resolveExit, 1000); child.once('exit', () => { clearTimeout(timer); resolveExit(); }); });
  }
}
