import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Config } from '../src/config.js';
import { AgentConnectionSchema } from '../src/agent-connection-schema.js';
import { WorkerClient } from '../src/ipc.js';
import { WorkerServer } from '../src/worker.js';
import { CodexAdapter, CODEX_VERSION } from '../src/runtime/codex.js';
import { WorkerJournal } from '../src/runtime/journal.js';

type FixtureState = {
  authenticated: boolean;
  loginCalls: number;
  cancellations: string[];
  reads: boolean[];
  adapter?: LoginFixture;
  early?: boolean;
  url?: string;
  startLogin?: () => Promise<void>;
  closeAuth?: () => Promise<void>;
  verificationFails?: boolean;
};
class LoginFixture extends EventEmitter {
  version = CODEX_VERSION;
  turnId?: string;
  private loggedIn = false;
  constructor(private fixture: FixtureState) { super(); }
  async start() {}
  async health(refreshToken = false) {
    this.fixture.reads.push(refreshToken);
    return { authenticated: this.fixture.authenticated, detail: this.fixture.authenticated ? 'fixture connected' : 'fixture authentication missing' };
  }
  async startDeviceLogin() {
    this.loggedIn = true; this.fixture.adapter = this; this.fixture.loginCalls++;
    await this.fixture.startLogin?.();
    if (this.fixture.early) this.complete(true);
    return { type: 'chatgptDeviceCode' as const, loginId: 'fixture-login', verificationUrl: this.fixture.url ?? 'https://auth.openai.com/codex/device', userCode: 'TEST-ONLY-CODE' };
  }
  complete(success: boolean, error: string | null = null, loginId = 'fixture-login') {
    if (success && !this.fixture.verificationFails) this.fixture.authenticated = true;
    this.emit('loginCompleted', { loginId, success, error });
  }
  async cancelDeviceLogin(loginId: string) { this.fixture.cancellations.push(loginId); this.complete(false, 'canceled'); return { status: 'canceled' as const }; }
  async close() { if (this.loggedIn) await this.fixture.closeAuth?.(); }
  async run() { this.turnId = 'fixture-turn'; setImmediate(() => this.emit('event', 'completed', { status: 'completed' })); }
  async interrupt() {}
}
function setup() {
  const directory = mkdtempSync(join(tmpdir(), 'operator-agent-auth-'));
  for (const name of ['worker', 'runtime', 'skills', 'workspaces', 'artifacts']) mkdirSync(join(directory, name));
  const config: Config = { stateDir: directory, runtimeHome: join(directory, 'runtime'), socketPath: join(directory, 'worker.sock'), bridgeSocket: join(directory, 'bridge.sock'), ipcToken: 'a'.repeat(64), controllerUid: process.getuid!(), codexBin: join(process.cwd(), 'node_modules/.bin/codex'), host: '127.0.0.1', port: 0, origins: [], adminPassword: 'fixture-admin-password', secureCookie: false, improvementEnabled: false, improvementTimeoutMs: 1000, improvementMaxTurns: 1, allowTempState: true };
  const fixture: FixtureState = { authenticated: false, loginCalls: 0, cancellations: [], reads: [] };
  const worker = (options?: { authTimeoutMs?: number }) => new WorkerServer(config, () => new LoginFixture(fixture) as unknown as CodexAdapter, options);
  return { directory, config, fixture, worker };
}
async function eventually<T>(read: () => Promise<T>, predicate: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 3000;
  while (true) { const value = await read(); if (predicate(value)) return value; if (Date.now() >= deadline) throw new Error('Timed out waiting for fixture state'); await new Promise(resolveWait => setTimeout(resolveWait, 10)); }
}

test('private worker RPC reuses and reattaches device login, then admits queued work after verified completion', async () => {
  const { directory, config, fixture, worker: createWorker } = setup(); const worker = createWorker(); const client = new WorkerClient(config); let reattached: WorkerClient | undefined;
  try {
    await worker.listen(); await client.connect();
    assert.equal((await client.request('agent/status', {})).state, 'disconnected');
    const connections = await Promise.all([client.request('agent/connect', {}), client.request('agent/connect', {})]);
    assert.equal(fixture.loginCalls, 1); assert.deepEqual(connections[0], connections[1]);
    const connecting = AgentConnectionSchema.parse(connections[0]); assert.equal(connecting.state, 'connecting'); assert.equal(connecting.userCode, 'TEST-ONLY-CODE'); assert.ok(connecting.expiresAt);
    assert.equal((await client.request('health')).runtime.authenticating, true);
    const submission = { runId: 'after-auth', conversationId: 'c', prompt: 'fixture', cwd: join(directory, 'workspaces/c'), bootstrap: '', skills: [] };
    await assert.rejects(client.request('submit', submission), /sign-in is in progress/);
    assert.equal((await client.request('sync', { after: 0 })).events.length, 0);
    client.close(); reattached = new WorkerClient(config); await reattached.connect();
    assert.deepEqual(await reattached.request('agent/status', {}), connecting, 'A controller/browser refresh must not lose the pending login');
    fixture.adapter!.complete(true);
    const connected = await eventually(() => reattached!.request('agent/status', {}), value => value.state === 'connected');
    assert.equal(connected.userCode, undefined); assert.equal(connected.verificationUrl, undefined);
    const health = await reattached.request('health'); assert.equal(health.runtime.authenticated, true); assert.equal(health.runtime.authenticating, false); assert.ok(fixture.reads.filter(Boolean).length >= 2);
    assert.equal((await reattached.request('sync', { after: 0 })).events.length, 0, 'Auth lifecycle must never create run execution events');
    assert.equal((await reattached.request('submit', submission)).accepted, true);
    await eventually(() => reattached!.request('health'), value => value.activeRunId === null);
  } finally { client.close(); reattached?.close(); await worker.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('worker handles completion arriving before login/start reply without losing success', async () => {
  const { directory, config, fixture, worker: createWorker } = setup(); fixture.early = true; const worker = createWorker(); const client = new WorkerClient(config);
  try {
    await worker.listen(); await client.connect();
    const connected = await client.request('agent/connect', {}); assert.equal(connected.state, 'connected'); assert.equal(connected.userCode, undefined); assert.equal((await client.request('health')).runtime.authenticated, true);
  } finally { client.close(); await worker.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('cancel stops the pending flow and a new connect starts a fresh device login', async () => {
  const { directory, config, fixture, worker: createWorker } = setup(); const worker = createWorker(); const client = new WorkerClient(config); let closed = false;
  try {
    await worker.listen(); await client.connect(); await client.request('agent/connect', {});
    const canceled = await client.request('agent/cancel', {}); assert.equal(canceled.state, 'disconnected'); assert.equal(canceled.userCode, undefined); assert.deepEqual(fixture.cancellations, ['fixture-login']);
    assert.equal((await client.request('health')).runtime.authenticating, false);
    await client.request('agent/connect', {}); assert.equal(fixture.loginCalls, 2);
    await worker.close(); closed = true; assert.equal(fixture.cancellations.length, 2, 'Worker shutdown must cancel its owned login');
  } finally { client.close(); if (!closed) await worker.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('expired and provider-failed logins clear one-time codes without exposing provider secrets', async () => {
  const { directory, config, fixture, worker: createWorker } = setup(); const worker = createWorker({ authTimeoutMs: 50 }); const client = new WorkerClient(config);
  try {
    await worker.listen(); await client.connect(); await client.request('agent/connect', {});
    const expired = await eventually(() => client.request('agent/status', {}), value => value.state === 'error'); assert.match(expired.error, /expired/); assert.equal(expired.userCode, undefined); assert.equal(fixture.cancellations.length, 1);
    await client.request('agent/connect', {}); fixture.adapter!.complete(false, 'provider failed: access_token=DO_NOT_RETURN_THIS_TOKEN');
    const failed = await eventually(() => client.request('agent/status', {}), value => value.state === 'error'); assert.match(failed.error, /failed/); assert.ok(!JSON.stringify(failed).includes('DO_NOT_RETURN_THIS_TOKEN')); assert.equal(failed.userCode, undefined);
    assert.equal((await client.request('sync', { after: 0 })).events.length, 0);
  } finally { client.close(); await worker.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('worker rejects an unexpected verification URL and cancels without returning its code', async () => {
  for (const url of ['https://attacker.invalid/codex/device', 'https://auth.openai.com/codex/device?token=secret', 'https://auth.openai.com/other']) {
    const { directory, config, fixture, worker: createWorker } = setup(); fixture.url = url; const worker = createWorker(); const client = new WorkerClient(config);
    try {
      await worker.listen(); await client.connect(); const result = await client.request('agent/connect', {});
      assert.equal(result.state, 'error'); assert.equal(result.verificationUrl, undefined); assert.equal(result.userCode, undefined); assert.equal(fixture.cancellations.length, 1); assert.ok(!JSON.stringify(result).includes(url));
    } finally { client.close(); await worker.close(); rmSync(directory, { recursive: true, force: true }); }
  }
});

test('sign-in stays unavailable to execution until its owned adapter has closed', async () => {
  const { directory, config, fixture, worker: createWorker } = setup(); let release: (() => void) | undefined;
  fixture.closeAuth = () => new Promise<void>(resolveClosed => { release = resolveClosed; }); const worker = createWorker(); const client = new WorkerClient(config);
  try {
    await worker.listen(); await client.connect(); await client.request('agent/connect', {}); fixture.adapter!.complete(true);
    await eventually(async () => release, Boolean); const during = await client.request('health'); assert.equal(during.runtime.authenticating, true); assert.equal(during.runtime.authenticated, false);
    release!(); await eventually(() => client.request('agent/status', {}), value => value.state === 'connected'); assert.equal((await client.request('health')).runtime.authenticating, false);
  } finally { release?.(); client.close(); await worker.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('success notification must match the login ID and verify the account before connecting', async () => {
  const { directory, config, fixture, worker: createWorker } = setup(); fixture.verificationFails = true; const worker = createWorker(); const client = new WorkerClient(config);
  try {
    await worker.listen(); await client.connect(); await client.request('agent/connect', {});
    fixture.adapter!.complete(true, null, 'different-login'); assert.equal((await client.request('agent/status', {})).state, 'connecting');
    fixture.adapter!.complete(true);
    const result = await eventually(() => client.request('agent/status', {}), value => value.state === 'error'); assert.match(result.error, /could not be verified/); assert.equal((await client.request('health')).runtime.authenticated, false);
  } finally { client.close(); await worker.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('cancel remains responsive while native login/start is pending and a late reply cannot revive the code', async () => {
  const { directory, config, fixture, worker: createWorker } = setup(); let release: (() => void) | undefined;
  fixture.startLogin = () => new Promise<void>(resolveStarted => { release = resolveStarted; }); const worker = createWorker(); const client = new WorkerClient(config);
  try {
    await worker.listen(); await client.connect(); const starting = client.request('agent/connect', {});
    await eventually(async () => fixture.loginCalls, value => value === 1); assert.equal((await client.request('health')).runtime.authenticating, true);
    assert.equal((await client.request('agent/cancel', {})).state, 'disconnected');
    release!(); const result = await starting; assert.equal(result.state, 'disconnected'); assert.equal(result.userCode, undefined); assert.equal((await client.request('agent/status', {})).state, 'disconnected');
  } finally { release?.(); client.close(); await worker.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('an unconfirmed auth-process cleanup keeps execution blocked until cancellation confirms cleanup', async () => {
  const { directory, config, fixture, worker: createWorker } = setup(); fixture.closeAuth = async () => { throw new Error('fixture cleanup failure'); }; const worker = createWorker(); const client = new WorkerClient(config);
  try {
    await worker.listen(); await client.connect(); await client.request('agent/connect', {}); fixture.adapter!.complete(false, 'fixture failure');
    const result = await eventually(() => client.request('agent/status', {}), value => value.state === 'error' && /could not be stopped/.test(value.error ?? '')); assert.equal(result.userCode, undefined);
    assert.equal((await client.request('health')).runtime.authenticating, true);
    await assert.rejects(client.request('submit', { runId: 'blocked', conversationId: 'c', prompt: 'fixture', cwd: join(directory, 'workspaces/c'), bootstrap: '', skills: [] }), /sign-in is in progress/);
    fixture.closeAuth = undefined; assert.equal((await client.request('agent/cancel', {})).state, 'disconnected'); assert.equal((await client.request('health')).runtime.authenticating, false);
  } finally { fixture.closeAuth = undefined; client.close(); await worker.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('agent connect refuses a representative check even before its helper starts', async () => {
  const { directory, config, worker: createWorker } = setup(); const worker = createWorker(); const client = new WorkerClient(config);
  const candidatePath = join(directory, 'skills/candidate'); mkdirSync(candidatePath); writeFileSync(join(candidatePath, 'SKILL.md'), 'fixture');
  try {
    await worker.listen(); await client.connect();
    const check = client.request('checkSkill', { candidatePath, checks: [{ name: 'fixture', command: process.execPath, args: ['-e', 'setTimeout(()=>process.stdout.write("checked"),100)'], fixtures: {}, expectedStdout: 'checked' }] });
    await assert.rejects(client.request('agent/connect', {}), /active run or skill check/); await check;
    assert.equal((await client.request('agent/connect', {})).state, 'connecting');
  } finally { client.close(); await worker.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('production root requirement rejects a non-root worker before opening state', { skip: process.getuid?.() === 0 }, async () => {
  const { directory, config, worker: createWorker } = setup(); config.requireRootWorker = true; const worker = createWorker();
  try { await assert.rejects(worker.listen(), /Root worker required/); }
  finally { await worker.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('authenticated replacement reservation blocks task, check and login admission until released', async () => {
  const { directory, config, fixture, worker: createWorker } = setup(); fixture.authenticated = true; const worker = createWorker(); const client = new WorkerClient(config);
  const candidatePath = join(directory, 'skills/candidate'); mkdirSync(candidatePath); writeFileSync(join(candidatePath, 'SKILL.md'), 'fixture');
  const check = { candidatePath, checks: [{ name: 'fixture', command: process.execPath, args: ['-e', 'process.stdout.write("checked")'], fixtures: {}, expectedStdout: 'checked' }] };
  const submission = { runId: 'after-reservation', conversationId: 'c', prompt: 'fixture', cwd: join(directory, 'workspaces/c'), bootstrap: '', skills: [] };
  try {
    await worker.listen(); await client.connect();
    for (const method of ['worker/reserve-root-replacement', 'worker/release-root-replacement']) await assert.rejects(client.request(method, { force: true }), /Unrecognized key/);
    const reserved = await client.request('worker/reserve-root-replacement', {}); assert.deepEqual(reserved, { reserved: true, pid: process.pid, uid: process.getuid!() });
    assert.deepEqual(await client.request('worker/reserve-root-replacement', {}), reserved, 'Repeated reservations are idempotent while admission stays closed');
    assert.equal((await client.request('health')).replacementReserved, true); assert.equal((await client.request('agent/status', {})).state, 'connected'); assert.equal((await client.request('sync', { after: 0 })).events.length, 0);
    for (const [method, input] of [['submit', submission], ['checkSkill', check], ['agent/connect', {}]] as const) await assert.rejects(client.request(method, input), /replacement is reserved/);
    assert.equal(worker.journal.get(submission.runId), undefined); assert.equal(worker.journal.checks().length, 0);
    assert.deepEqual(await client.request('worker/release-root-replacement', {}), { reserved: false }); assert.equal((await client.request('health')).replacementReserved, false);
    await client.request('checkSkill', check); assert.equal((await client.request('agent/connect', {})).state, 'connected'); assert.equal((await client.request('submit', submission)).accepted, true);
    await eventually(() => client.request('health'), value => value.activeRunId === null);
  } finally { client.close(); await worker.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('replacement reservation rejects an accepted skill check before it reaches the durable journal', async () => {
  const { directory, worker: createWorker } = setup(); const worker = createWorker(); const candidatePath = join(directory, 'skills/candidate'); mkdirSync(candidatePath);
  const dispatch = (worker as unknown as { dispatch(method: string, input: unknown): Promise<unknown> }).dispatch.bind(worker);
  try {
    await worker.listen();
    // Invoke both dispatches in one event-loop turn, as two authenticated frames in
    // one socket read are handled, before the serialized check's microtask starts.
    const checking = dispatch('checkSkill', { candidatePath, checks: [{ name: 'fixture', command: process.execPath, args: ['-e', 'process.stdout.write("checked")'], fixtures: {}, expectedStdout: 'checked' }] });
    assert.equal(worker.journal.checks().length, 0, 'The accepted check has not started or journaled a helper yet');
    await assert.rejects(dispatch('worker/reserve-root-replacement', {}), /pending skill checks/);
    await checking; assert.equal((await dispatch('worker/reserve-root-replacement', {}) as any).reserved, true); await dispatch('worker/release-root-replacement', {});
  } finally { await worker.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('a task already waiting for admission cannot enter after replacement is reserved', async () => {
  const { directory, fixture, worker: createWorker } = setup(); fixture.authenticated = true; const worker = createWorker();
  const dispatch = (worker as unknown as { dispatch(method: string, input: unknown): Promise<unknown> }).dispatch.bind(worker);
  try {
    await worker.listen(); const submission = { runId: 'racing-reservation', conversationId: 'c', prompt: 'fixture', cwd: join(directory, 'workspaces/c'), bootstrap: '', skills: [] };
    const submitting = dispatch('submit', submission); assert.equal(worker.journal.get(submission.runId), undefined);
    await dispatch('worker/reserve-root-replacement', {}); await assert.rejects(submitting, /replacement is reserved/); assert.equal(worker.journal.get(submission.runId), undefined);
    await dispatch('worker/release-root-replacement', {});
  } finally { await worker.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('replacement reservation refuses pending authentication and uncertain execution', async () => {
  const { directory, config, worker: createWorker } = setup(); const worker = createWorker(); const client = new WorkerClient(config);
  try {
    await worker.listen(); await client.connect(); await client.request('agent/connect', {}); await assert.rejects(client.request('worker/reserve-root-replacement', {}), /ChatGPT sign-in/); await client.request('agent/cancel', {});
    worker.journal.accept({ runId: 'uncertain-replacement', conversationId: 'c', prompt: 'fixture', cwd: directory, bootstrap: '', skills: [] }); worker.journal.status('uncertain-replacement', 'uncertain');
    await assert.rejects(client.request('worker/reserve-root-replacement', {}), /uncertain execution/); assert.equal((await client.request('health')).replacementReserved, false);
  } finally { client.close(); await worker.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('connection RPC validates empty params, refuses uncertain execution, and returns existing authenticated state', async () => {
  const { directory, config, fixture, worker: createWorker } = setup();
  const journal = new WorkerJournal(directory); journal.accept({ runId: 'uncertain', conversationId: 'c', prompt: 'fixture', cwd: directory, bootstrap: '', skills: [] }); journal.close();
  const worker = createWorker(); const client = new WorkerClient(config);
  try {
    await worker.listen(); await client.connect();
    for (const method of ['agent/status', 'agent/connect', 'agent/cancel']) await assert.rejects(client.request(method, { apiKey: 'must-not-accept' }), /Unrecognized key/);
    await assert.rejects(client.request('agent/connect', {}), /uncertain execution/); assert.equal(fixture.loginCalls, 0);
    await client.request('resolve', { runId: 'uncertain' });
    fixture.authenticated = true; const connected = await client.request('agent/connect', {}); assert.equal(connected.state, 'connected'); assert.equal(fixture.loginCalls, 0, 'An already authenticated account should not start a device flow');
  } finally { client.close(); await worker.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('native adapter surfaces device completion separately from execution events', async () => {
  const { directory, config } = setup(); config.codexBin = join(directory, 'native-auth-protocol-fixture.mjs');
  writeFileSync(config.codexBin, `#!/usr/bin/env node
import readline from 'node:readline';
if(process.argv.includes('--version')){console.log('codex-cli 0.166.0');process.exit(0);}
const send=value=>process.stdout.write(JSON.stringify(value)+'\\n');
readline.createInterface({input:process.stdin}).on('line',line=>{
const message=JSON.parse(line);if(message.id===undefined)return;
if(message.method==='account/login/start')send({method:'account/login/completed',params:{loginId:'native-fixture',success:false,error:'fixture canceled',onboardingEntrypoint:null}});
const result=message.method==='account/login/start'?{type:'chatgptDeviceCode',loginId:'native-fixture',verificationUrl:'https://auth.openai.com/codex/device',userCode:'TEST-CODE'}:message.method==='account/login/cancel'?{status:'canceled'}:{};
send({id:message.id,result});});
`, { mode: 0o700 });
  const adapter = new CodexAdapter(config); const events: unknown[] = []; let completion: unknown;
  adapter.on('event', (...args) => events.push(args)); adapter.on('loginCompleted', event => { completion = event; });
  try {
    await adapter.start(); const login = await adapter.startDeviceLogin(); assert.equal(login.type, 'chatgptDeviceCode'); assert.deepEqual(completion, { loginId: 'native-fixture', success: false, error: 'fixture canceled' }); assert.equal(events.length, 0); assert.equal((await adapter.cancelDeviceLogin(login.loginId)).status, 'canceled');
  } finally { await adapter.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('pinned app-server supports real device start/cancel using an isolated empty profile', { timeout: 45_000, skip: process.env.OPERATOR_DEVICE_AUTH_NETWORK_TEST !== '1' }, async () => {
  const { directory, config } = setup(); const adapter = new CodexAdapter(config);
  try {
    await adapter.start(); assert.equal((await adapter.health()).authenticated, false);
    const login = await adapter.startDeviceLogin(); assert.equal(login.type, 'chatgptDeviceCode'); assert.ok(AgentConnectionSchema.shape.verificationUrl.safeParse(login.verificationUrl).success); assert.ok(login.userCode.length > 0);
    assert.equal((await adapter.cancelDeviceLogin(login.loginId)).status, 'canceled'); assert.equal((await adapter.health(true)).authenticated, false);
  } finally { await adapter.close(); rmSync(directory, { recursive: true, force: true }); }
});
