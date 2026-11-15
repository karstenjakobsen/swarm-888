import { createServer, type Server, type Socket } from 'node:net';
import { timingSafeEqual, randomUUID } from 'node:crypto';
import { chownSync, chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { resolve, relative, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { loadConfig, type Config } from './config.js';
import { checkSkillSchema, readFrames, submitSchema, type Submission, type WorkerEvent, type WorkerHealth } from './ipc.js';
import { CodexAdapter, CODEX_VERSION } from './runtime/codex.js';
import { AgentAuthenticator } from './runtime/auth.js';
import { checkSkill } from './runtime/fixtures.js';
import { WorkerJournal, type JournalRun, type JournalCheck } from './runtime/journal.js';
import { processStamp, bootId, groupMembers, terminateGroup } from './runtime/processes.js';

const runIdInput = z.object({ runId: z.string().min(1) });
const emptyInput = z.object({}).strict();
type Active = { submission: Submission; adapter: CodexAdapter; completed: boolean; interruptRequested: boolean; timer?: NodeJS.Timeout; delta?: { text: string; itemId: string }; deltaTimer?: NodeJS.Timeout };

export class WorkerServer {
  private server?: Server;
  private clients = new Set<Socket>();
  private active?: Active;
  private runtime: WorkerHealth['runtime'] = { available: false, version: CODEX_VERSION, authenticated: false, detail: 'Codex runtime has not been checked' };
  private healthCheckedAt = 0;
  private probing?: Promise<void>;
  private lockPath: string;
  journal!: WorkerJournal;
  private checks: Promise<unknown> = Promise.resolve();
  private pendingChecks = 0;
  private authenticator: AgentAuthenticator;
  private replacementReserved = false;
  private closing = false;
  private lockOwned = false;
  constructor(private config: Config, private adapterFactory: (config: Config, runId?: string) => CodexAdapter = (config, runId) => new CodexAdapter(config, runId), options: { authTimeoutMs?: number } = {}) {
    this.lockPath = resolve(config.stateDir, 'worker/lock.json');
    this.authenticator = new AgentAuthenticator(() => this.adapterFactory(this.config), {
      timeoutMs: options.authTimeoutMs,
      beforeStart: async () => { if (this.probing) await this.probing; if (this.closing) throw new Error('Worker is stopping'); },
      changed: (connection, busy, health) => {
        this.runtime = { ...this.runtime, authenticating: busy, ...(health ? { available: true, ...health } : {}),
          ...(connection.state === 'connecting' && !health ? { detail: 'Waiting for ChatGPT sign-in' } : {}),
          ...(connection.error ? { authenticated: false, detail: connection.error } : {}),
          ...(connection.state === 'disconnected' && !busy ? { authenticated: false, detail: 'Model authentication missing. Connect the agent to sign in with ChatGPT.' } : {}) };
        if (!busy) { this.healthCheckedAt = Date.now(); this.repairOwnership(); }
      },
    });
  }
  async listen(): Promise<void> {
    if (this.config.requireRootWorker === true && process.getuid?.() !== 0) throw new Error('Root worker required. Launch sudo env APP_CONTROLLER_UID=<controller UID> npm run worker from the project directory.');
    this.acquireLock();
    this.journal = new WorkerJournal(this.config.stateDir);
    // A different stdio client cannot reattach after a worker crash. Keep uncertain runs
    // blocked until their owned process group has been resolved; never resubmit them.
    for (const run of this.journal.active()) this.journal.status(run.id, 'uncertain');
    for (const check of this.journal.checks()) this.journal.checkStatus(check.id, 'uncertain');
    if (existsSync(this.config.socketPath)) {
      if (!lstatSync(this.config.socketPath).isSocket()) throw new Error('Refusing to replace a non-socket worker path');
      rmSync(this.config.socketPath);
    }
    this.server = createServer(socket => this.connection(socket));
    await new Promise<void>((resolveListen, reject) => { this.server!.once('error', reject); this.server!.listen(this.config.socketPath, resolveListen); });
    chmodSync(this.config.socketPath, 0o600);
    if (process.getuid?.() === 0) chownSync(this.config.socketPath, this.config.controllerUid, -1);
    await this.probe();
    this.repairOwnership();
  }
  private acquireLock(): void {
    if (existsSync(this.lockPath)) {
      const previous = z.object({ pid: z.number(), start: z.string().nullable() }).parse(JSON.parse(readFileSync(this.lockPath, 'utf8')));
      if (previous.start !== null && processStamp(previous.pid) === previous.start) throw new Error(`Worker already owns the state directory (PID ${previous.pid})`);
      rmSync(this.lockPath);
    }
    writeFileSync(this.lockPath, JSON.stringify({ pid: process.pid, start: processStamp(process.pid) }), { flag: 'wx', mode: 0o600 });
    this.lockOwned = true;
  }
  private async probe(): Promise<void> {
    if (this.active || this.authenticator.busy || Date.now() - this.healthCheckedAt < 30_000) return;
    if (this.probing) return this.probing;
    this.probing = (async () => {
      const adapter = this.adapterFactory(this.config);
      adapter.on('fault', () => {}); adapter.on('exit', () => {});
      try { await adapter.start(); const health = await adapter.health(); this.runtime = { available: true, version: adapter.version, ...health, authenticating: this.authenticator.busy, ...(this.config.model ? { model: this.config.model } : {}) }; }
      catch (error) { this.runtime = { available: false, version: CODEX_VERSION, authenticated: false, authenticating: this.authenticator.busy, detail: this.redact(error instanceof Error ? error.message : String(error)) }; }
      finally { await adapter.close(); this.healthCheckedAt = Date.now(); }
    })();
    try { await this.probing; } finally { this.probing = undefined; }
  }
  health(): WorkerHealth {
    return { connected: true, uid: process.getuid?.() ?? -1, pid: process.pid, root: process.getuid?.() === 0, runtime: this.runtime, replacementReserved: this.replacementReserved,
      activeRunId: this.active?.submission.runId ?? null, uncertainRuns: [...new Set([...this.journal.active().filter(run => run.status === 'uncertain').map(run => run.id), ...this.journal.checks().filter(check => check.status === 'uncertain').map(check => check.run_id ?? check.id)])] };
  }
  private connection(socket: Socket): void {
    let authenticated = false;
    const authDeadline = setTimeout(() => { if (!authenticated) socket.destroy(); }, 5000);
    socket.on('error', () => {}); socket.on('close', () => { clearTimeout(authDeadline); this.clients.delete(socket); });
    readFrames(socket, frame => {
      void (async () => {
        if (frame.id === undefined || !frame.method) throw new Error('IPC requests require id and method');
        if (!authenticated) {
          const input = z.object({ token: z.string().length(64) }).parse(frame.params);
          if (frame.method !== 'hello' || !timingSafeEqual(Buffer.from(input.token), Buffer.from(this.config.ipcToken))) throw new Error('Worker authentication failed');
          authenticated = true; clearTimeout(authDeadline); this.clients.add(socket); return this.health();
        }
        return await this.dispatch(frame.method, frame.params);
      })().then(result => { if (!socket.destroyed) socket.write(JSON.stringify({ id: frame.id, result }) + '\n'); })
        .catch(error => { if (!socket.destroyed) socket.write(JSON.stringify({ id: frame.id, error: { message: this.redact(error instanceof Error ? error.message : String(error)) } }) + '\n'); if (!authenticated) socket.end(); });
    });
  }
  private async dispatch(method: string, raw: unknown): Promise<unknown> {
    if (this.closing) throw new Error('Worker is stopping');
    if (method === 'worker/reserve-root-replacement') {
      emptyInput.parse(raw);
      if (this.active || this.pendingChecks || this.journal.active().length || this.journal.checks().length || this.authenticator.busy) throw new Error('The worker has active or uncertain execution, pending skill checks, or ChatGPT sign-in. Finish or reconcile it before replacing the worker.');
      // Reserve admission synchronously before waiting for an existing read-only probe.
      this.replacementReserved = true;
      try {
        if (this.probing) await this.probing;
        if (this.closing || !this.replacementReserved) throw new Error('Worker replacement reservation was released or the worker is stopping');
        return { reserved: true, pid: process.pid, uid: process.getuid?.() ?? -1 };
      } catch (error) { this.replacementReserved = false; throw error; }
    }
    if (method === 'worker/release-root-replacement') { emptyInput.parse(raw); this.replacementReserved = false; return { reserved: false }; }
    if (this.replacementReserved && ['submit', 'checkSkill', 'agent/connect'].includes(method)) throw new Error('Worker replacement is reserved. Release the reservation or wait for the root worker before submitting tasks, skill checks, or sign-in.');
    if (method === 'agent/status') { emptyInput.parse(raw); await this.probe(); return this.authenticator.status(this.runtime.authenticated); }
    if (method === 'agent/connect') {
      emptyInput.parse(raw);
      if (this.authenticator.busy) return await this.authenticator.connect();
      if (this.runtime.authenticated) return this.authenticator.status(true);
      if (this.active || this.pendingChecks || this.journal.active().length || this.journal.checks().length) throw new Error('Wait for the active run or skill check, and resolve any uncertain execution, before connecting the agent');
      return await this.authenticator.connect();
    }
    if (method === 'agent/cancel') { emptyInput.parse(raw); return await this.authenticator.cancel(this.runtime.authenticated); }
    if (method === 'health') { await this.probe(); return this.health(); }
    if (method === 'sync') {
      const { after } = z.object({ after: z.number().int().nonnegative() }).parse(raw);
      return { health: this.health(), ...this.journal.replayPage(after), activeRunId: this.active?.submission.runId ?? null, knownRuns: this.journal.active().map(run => ({ runId: run.id, status: run.status })) };
    }
    if (method === 'acknowledge') { const { cursor } = z.object({ cursor: z.number().int().nonnegative() }).parse(raw); this.journal.acknowledge(cursor); return { acknowledged: cursor }; }
    if (method === 'submit') {
      const submission = submitSchema.parse(raw);
      const known = this.journal.get(submission.runId);
      if (known) return { accepted: true, duplicate: true, status: known.status };
      if (this.authenticator.busy) throw new Error('ChatGPT sign-in is in progress. Finish or cancel the agent connection before running tasks');
      if (this.active || this.journal.active().length || this.journal.checks().some(check => check.status === 'uncertain')) throw new Error('Worker is occupied or has an unresolved orphan run/check');
      if (this.probing) await this.probing;
      let pendingChecks: Promise<unknown>;
      do { pendingChecks = this.checks; await pendingChecks; } while (pendingChecks !== this.checks);
      if (this.active || this.journal.active().length || this.journal.checks().length) throw new Error('Worker became occupied or has an orphan check while waiting for representative checks');
      if (this.journal.count() >= this.journal.maxEvents - 10) throw new Error('Worker outbox needs controller acknowledgement before another run');
      if (!this.runtime.available || !this.runtime.authenticated) { await this.probe(); if (!this.runtime.available || !this.runtime.authenticated) throw new Error(this.runtime.detail); }
      if (this.authenticator.busy) throw new Error('ChatGPT sign-in is in progress. Finish or cancel the agent connection before running tasks');
      if (this.replacementReserved) throw new Error('Worker replacement is reserved. Wait for the root worker before submitting tasks.');
      this.journal.accept(submission);
      const adapter = this.adapterFactory(this.config, submission.runId);
      const active: Active = { submission, adapter, completed: false, interruptRequested: false }; this.active = active;
      this.record(active, 'status', { status: 'running', accepted: true });
      setImmediate(() => void this.execute(active));
      return { accepted: true, duplicate: false, status: 'accepted' };
    }
    if (method === 'interrupt') {
      const { runId } = runIdInput.parse(raw); const active = this.requireActive(runId); active.interruptRequested = true;
      if (active.adapter.turnId) await active.adapter.interrupt();
      this.record(active, 'activity', { method: 'operator/interrupt', message: 'Interruption requested; waiting for observed runtime outcome. Detached services may continue.' });
      return { requested: true };
    }
    if (method === 'reply') {
      const input = z.object({ runId: z.string(), requestId: z.string(), answers: z.unknown() }).parse(raw);
      const active = this.requireActive(input.runId); active.adapter.reply(input.requestId, input.answers); this.journal.status(input.runId, 'running'); return { answered: true };
    }
    if (method === 'resolve') {
      const { runId } = runIdInput.parse(raw); const run = this.journal.get(runId);
      const standalone = this.journal.checks().find(check => check.id === runId && check.run_id === null && check.status === 'uncertain');
      if (standalone) { await this.resolveOrphan(standalone); this.journal.finishCheck(standalone.id); this.repairOwnership(); return { resolved: true, known: true, kind: 'skillCheck', message: 'Owned orphan fixture check terminated/confirmed absent; its side effects were not repeated' }; }
      if (!run && !this.active && this.journal.active().length === 0 && this.journal.checks().length === 0) return { resolved: true, known: false, message: 'No worker acceptance record; owner acknowledged host reconciliation' };
      if (run && ['completed', 'failed', 'interrupted'].includes(run.status) && !this.active) { await this.resolveOrphan(run); for (const check of this.journal.checks().filter(check => check.run_id === runId)) { await this.resolveOrphan(check); this.journal.finishCheck(check.id); } return { resolved: true, known: true, status: run.status }; }
      if (!run || run.status !== 'uncertain') throw new Error('Only an uncertain orphan run can be resolved');
      await this.resolveOrphan(run);
      for (const check of this.journal.checks().filter(check => check.run_id === runId)) { await this.resolveOrphan(check); this.journal.finishCheck(check.id); }
      this.journal.status(runId, 'failed'); const event = this.journal.append(runId, 'completed', { status: 'failed', error: 'Worker restarted; owned orphan execution was terminated/confirmed absent. Side effects are uncertain and were not repeated.' }, true); this.broadcast(event);
      this.repairOwnership(); return { resolved: true };
    }
    if (method === 'checkSkill') {
      if (this.authenticator.busy) throw new Error('Finish or cancel ChatGPT sign-in before validating a skill');
      if (this.active?.completed) throw new Error('Run is finishing; retry validation once execution is idle');
      const input = checkSkillSchema.parse(raw);
      const root = realpathSync(resolve(this.config.stateDir, 'skills')); const path = realpathSync(input.candidatePath); const rel = relative(root, path);
      if (rel.startsWith(`..${sep}`) || rel === '..') throw new Error('Skill checks require an application-owned candidate package');
      if (this.journal.checks().some(check => check.status === 'uncertain')) throw new Error('Resolve the owned orphan fixture check before validating another package');
      this.pendingChecks++;
      const operation = this.checks.then(async () => {
        const id = `fixture_${randomUUID()}`;
        this.journal.beginCheck(id, this.active?.submission.runId ?? null, path);
        try {
          const result = await checkSkill(this.config.stateDir, { ...input, candidatePath: path }, { spawned: pid => this.journal.checkChild(id, pid, processStamp(pid) ?? '', bootId()) });
          this.journal.finishCheck(id); this.repairOwnership(); return result;
        } catch (error) { this.journal.checkStatus(id, 'uncertain'); throw error; }
      }).finally(() => { this.pendingChecks--; });
      this.checks = operation.catch(() => undefined); return await operation;
    }
    throw new Error(`Unsupported worker method: ${method}`);
  }
  private requireActive(runId: string): Active { if (!this.active || this.active.submission.runId !== runId || this.active.completed) throw new Error('Run is not active in this worker'); return this.active; }
  private prepareSkills(submission: Submission): void {
    mkdirSync(submission.cwd, { recursive: true, mode: 0o700 });
    const agents = resolve(submission.cwd, '.agents');
    if (existsSync(agents) && lstatSync(agents).isSymbolicLink()) throw new Error('Workspace .agents may not be a symlink');
    mkdirSync(agents, { recursive: true, mode: 0o700 });
    const discovery = resolve(agents, 'skills');
    if (existsSync(discovery)) rmSync(discovery, { recursive: true, force: true });
    mkdirSync(discovery, { mode: 0o700 });
    const skillRoot = realpathSync(resolve(this.config.stateDir, 'skills'));
    for (const skill of submission.skills) {
      const path = realpathSync(skill.path); const rel = relative(skillRoot, path);
      if (rel === '..' || rel.startsWith(`..${sep}`)) throw new Error('Skill path is outside application skill packages');
      symlinkSync(path, resolve(discovery, skill.name), 'dir');
    }
  }
  private async execute(active: Active): Promise<void> {
    const adapter = active.adapter;
    adapter.on('spawn', ({ pid }: { pid: number }) => this.journal.child(active.submission.runId, pid, processStamp(pid) ?? '', bootId()));
    adapter.on('event', (type: string, data: unknown) => {
      if (active.completed) return;
      try {
        if (type === 'completed') { void this.finish(active, data as { status: string; error?: unknown }); return; }
        if (type === 'clarification') this.journal.status(active.submission.runId, 'waiting');
        this.record(active, type, data);
      } catch (error) { void this.abort(active, error instanceof Error ? error.message : String(error)); }
    });
    adapter.on('fault', (error: Error) => void this.abort(active, error.message));
    adapter.on('exit', () => { if (!active.completed) void this.finish(active, { status: 'failed', error: 'Codex app-server exited before completion; side effects may have occurred' }); });
    try {
      this.prepareSkills(active.submission); this.journal.status(active.submission.runId, 'running');
      await adapter.start();
      const health = await adapter.health(); if (!health.authenticated) throw new Error(health.detail);
      await adapter.run(active.submission);
      if (active.interruptRequested && !active.completed) await adapter.interrupt();
      if (active.submission.timeoutMs && !active.completed) active.timer = setTimeout(() => void this.abort(active, 'Configured run timeout exceeded'), active.submission.timeoutMs);
    } catch (error) { await this.abort(active, error instanceof Error ? error.message : String(error)); }
  }
  private record(active: Active, type: string, data: unknown): void {
    if (active.completed) return;
    if (type === 'delta') {
      const delta = z.object({ text: z.string(), itemId: z.string() }).parse(data);
      if (active.delta && active.delta.itemId !== delta.itemId) this.flush(active, true);
      if (active.delta) active.delta.text += delta.text; else active.delta = delta;
      if (!active.deltaTimer) active.deltaTimer = setTimeout(() => { try { this.flush(active); } catch (error) { void this.abort(active, error instanceof Error ? error.message : String(error)); } }, 50);
      return;
    }
    this.flush(active, true);
    const clean = this.clean(data);
    this.broadcast(this.journal.append(active.submission.runId, type, clean));
  }
  private flush(active: Active, force = false): void {
    if (active.deltaTimer) { clearTimeout(active.deltaTimer); active.deltaTimer = undefined; }
    if (!active.delta) return;
    const delta = active.delta; const clean = this.redact(delta.text); let held = 0;
    // Keep only a suffix that could be a split configured credential. Ordinary text
    // still streams immediately, and item boundaries force the final flush.
    if (!force) for (const secret of this.secretVariants()) {
      for (let length = Math.min(secret.length - 1, clean.length); length > held; length--) if (clean.endsWith(secret.slice(0, length))) { held = length; break; }
    }
    const text = held ? clean.slice(0, -held) : clean;
    active.delta = held ? { text: clean.slice(-held), itemId: delta.itemId } : undefined;
    if (text) this.broadcast(this.journal.append(active.submission.runId, 'delta', { itemId: delta.itemId, text }));
  }
  private async abort(active: Active, reason: string): Promise<void> {
    if (active.completed) return;
    await this.finish(active, { status: 'failed', error: this.redact(reason) });
  }
  private async finish(active: Active, result: { status: string; error?: unknown }): Promise<void> {
    if (active.completed) return;
    try { this.flush(active, true); } catch { active.delta = undefined; }
    active.completed = true; clearTimeout(active.timer); clearTimeout(active.deltaTimer);
    try {
      await active.adapter.close();
      for (const check of this.journal.checks().filter(check => check.run_id === active.submission.runId)) await this.resolveOrphan(check);
      await this.checks;
      this.journal.status(active.submission.runId, result.status);
      this.broadcast(this.journal.append(active.submission.runId, 'completed', this.clean(result), true));
    } catch (error) {
      this.journal.status(active.submission.runId, 'uncertain');
      this.broadcast(this.journal.append(active.submission.runId, 'completed', { status: 'failed', uncertain: true, error: this.redact(error instanceof Error ? error.message : String(error)) }, true));
    }
    if (this.active === active) this.active = undefined;
    this.repairOwnership();
  }
  private broadcast(event: WorkerEvent): void { for (const client of this.clients) { if (client.writableLength > 4 * 1024 * 1024) client.destroy(); else client.write(JSON.stringify({ method: 'event', params: event }) + '\n'); } }
  private redact(value: string): string {
    for (const secret of this.secretVariants()) value = value.split(secret).join('[REDACTED]');
    return value;
  }
  private clean(value: unknown): unknown {
    if (typeof value === 'string') return this.redact(value);
    if (Array.isArray(value)) return value.map(item => this.clean(item));
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, this.clean(item)]));
    return value;
  }
  private secretVariants(): string[] {
    const variants = new Set<string>();
    for (const secret of [this.config.ipcToken, this.config.adminPassword, ...Object.entries(process.env).filter(([key]) => /(?:KEY|TOKEN|PASSWORD|SECRET)$/.test(key)).map(([, value]) => value)]) {
      if (secret && secret.length >= 6) { variants.add(JSON.stringify(secret).slice(1, -1)); variants.add(secret); }
    }
    return [...variants].sort((a, b) => b.length - a.length);
  }
  private async resolveOrphan(run: JournalRun | JournalCheck): Promise<void> {
    if (!run.child_pid || run.boot_id !== bootId()) return;
    const members = groupMembers(run.child_pid);
    if (!members.length) return;
    if (!run.child_start || members.some(member => member.sid !== run.child_pid || BigInt(member.start) < BigInt(run.child_start!))) throw new Error('Cannot verify orphan process group ownership; inspect the host before resolving');
    const current = processStamp(run.child_pid);
    if (current && current !== run.child_start) throw new Error('Orphan PID was reused; inspect the host before resolving');
    await terminateGroup(run.child_pid);
  }
  private repairOwnership(): void {
    if (process.getuid?.() !== 0) return;
    const visit = (path: string) => {
      try { const stat = lstatSync(path); if (stat.isSymbolicLink()) return; chownSync(path, this.config.controllerUid, -1); if (stat.isDirectory()) for (const name of readdirSync(path)) visit(resolve(path, name)); } catch {}
    };
    // Controller remains the owner of durable data so maintenance-window snapshots work.
    // Agent-created paths outside these roots intentionally retain host semantics.
    for (const path of ['runtime', 'workspaces', 'artifacts', 'worker']) visit(resolve(this.config.stateDir, path));
  }
  async close(): Promise<void> {
    this.closing = true;
    await this.authenticator.close();
    if (this.probing) await this.probing;
    if (this.active) await this.finish(this.active, { status: 'interrupted', error: 'Worker shut down and terminated its owned runtime process group. Detached services may continue.' });
    await this.checks;
    for (const socket of this.clients) socket.destroy(); this.clients.clear();
    if (this.server) await new Promise<void>(resolveClose => this.server!.close(() => resolveClose()));
    this.journal?.close();
    if (this.lockOwned) { rmSync(this.config.socketPath, { force: true }); rmSync(this.lockPath, { force: true }); this.lockOwned = false; }
    this.repairOwnership();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const config = loadConfig(); const worker = new WorkerServer(config);
  try {
    await worker.listen();
    console.log(`Worker listening on private Unix socket; UID ${process.getuid?.()} (${process.getuid?.() === 0 ? 'host root' : 'non-root development mode'}), Codex ${CODEX_VERSION}`);
    let stopping = false;
    for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => { if (!stopping) { stopping = true; void worker.close().then(() => process.exit(0)); } });
  } catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
}
