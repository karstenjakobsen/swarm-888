import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createController } from '../src/controller.ts';
import { initState, type Config } from '../src/config.ts';
import type { WorkerClient } from '../src/ipc.ts';

const origin = 'http://127.0.0.1:5173';
const verificationUrl = 'https://auth.openai.com/codex/device';
const userCode = 'TEST-DEVICE-CODE';

/** Simulates only the private worker boundary; no model process or credentials. */
class ConnectionWorker extends EventEmitter {
  uid = 1234;
  authenticated = false;
  authenticating = false;
  available = true;
  activeRunId: string | null = null;
  uncertainRuns: string[] = [];
  runtimeOperations:Array<{id:string;method:string;status:'running';requiresExternalInspection:boolean}>=[];
  connection: Record<string, unknown> = { state: 'disconnected', workerConnected: true, workerUid: 1234 };
  calls: Array<{ method: string; params: any }> = [];
  submissions: any[] = [];
  online = true;
  executionUid?:number;
  sourceProtected?:boolean;
  projectsDir?:string;

  health() {
    return {
      connected: true, uid: this.uid, pid: 4321, root: this.uid === 0,
      runtime: { available: this.available, version: 'connection-fixture', authenticated: this.authenticated, authenticating: this.authenticating, detail: 'Isolated connection fixture' },
      activeRunId: this.activeRunId, uncertainRuns: this.uncertainRuns, runtimeOperations:this.runtimeOperations,
      ...(this.executionUid===undefined?{}:{executionUid:this.executionUid}),
      ...(this.sourceProtected===undefined?{}:{sourceProtected:this.sourceProtected}),
      ...(this.projectsDir===undefined?{}:{projectsDir:this.projectsDir}),
    };
  }
  async connect() {
    if (!this.online) throw Object.assign(new Error('Fixture worker socket missing'), { code: 'ENOENT' });
    return this.health();
  }
  async request(method: string, params: any = {}) {
    this.calls.push({ method, params });
    if (!this.online) throw new Error('Fixture worker disconnected');
    if (method === 'health') return this.health();
    if (method === 'sync') return { health: this.health(), events: [], activeRunId: this.activeRunId, knownRuns: [], hasMore: false, nextCursor: params.after ?? 0 };
    if (method === 'acknowledge') return { ok: true };
    if (method === 'agent/status') return { ...this.connection };
    if (method === 'agent/connect') {
      this.authenticating = true;
      if (this.connection.state !== 'connecting') this.connection = {
        state: 'connecting', workerConnected: true, workerUid: 1234,
        verificationUrl, userCode, expiresAt: new Date(Date.now() + 900_000).toISOString(),
      };
      return { ...this.connection };
    }
    if (method === 'agent/cancel') {
      this.authenticating = false;
      this.connection = { state: 'disconnected', workerConnected: true, workerUid: 1234 };
      return { ...this.connection };
    }
    if (method === 'submit') {
      assert.equal(this.authenticated, true, 'A signed-out worker must never receive a task');
      assert.equal(this.authenticating, false, 'A login in progress must pause execution');
      this.submissions.push(params);
      this.activeRunId = params.runId;
      return { accepted: true };
    }
    throw new Error(`Unexpected fixture RPC: ${method}`);
  }
  complete() {
    this.authenticating = false;
    this.authenticated = true;
    this.connection = { state: 'connected', workerConnected: true, workerUid: 1234 };
  }
  close() {}
}

async function fixture() {
  const stateDir = mkdtempSync(join(tmpdir(), 'operator-agent-connection-'));
  const config: Config = {
    stateDir, socketPath: join(stateDir, 'worker.sock'), bridgeSocket: join(stateDir, 'bridge.sock'), ipcToken: '',
    controllerUid: process.getuid?.() ?? 1000, codexBin: '/fixture/unused-codex', runtimeHome: join(stateDir, 'runtime'),
    host: '127.0.0.1', port: 3001, origins: [origin], adminPassword: 'agent-connection-fixture-password',
    secureCookie: false, improvementEnabled: false, improvementTimeoutMs: 10_000, improvementMaxTurns: 2, allowTempState: true,
  };
  initState(config);
  const worker = new ConnectionWorker();
  worker.projectsDir=join(stateDir,'projects');
  const controller = await createController(config, { client: worker as unknown as WorkerClient, startQueue: false, startBridge: false });
  // Foundation validation has its own integration tests; this fixture has no process executor.
  controller.brain.skillAction('skill-maintenance', 'disable');
  const login = await controller.app.inject({ method: 'POST', url: '/api/login', headers: { origin }, payload: { password: config.adminPassword } });
  assert.equal(login.statusCode, 200);
  const cookie = String(login.headers['set-cookie']).split(';')[0]!;
  const headers = { origin, cookie, 'x-csrf-token': login.json().csrfToken as string };
  return {
    ...controller, config, worker, headers,
    async dispose() { await controller.close(); rmSync(stateDir, { recursive: true, force: true }); },
  };
}

async function eventually(condition: () => boolean, message: string) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (condition()) return;
    await new Promise<void>(resolve => setTimeout(resolve, 10));
  }
  assert.ok(condition(), message);
}

function assertNoAuthPersistence(controller: Awaited<ReturnType<typeof fixture>>) {
  // Check every application table, including events, settings, memory and messages.
  const tables = controller.store.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as Array<{ name: string }>;
  const persisted = JSON.stringify(tables.map(({ name }) => controller.store.db.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}"`).all()));
  assert.equal(persisted.includes(userCode), false, 'Device code must stay outside all durable application data');
  assert.equal(persisted.includes(verificationUrl), false, 'The pending login must not become an execution event');
}

test('agent connection endpoints require administrator session, configured Origin and CSRF', async () => {
  const f = await fixture();
  try {
    const paths = ['/api/agent/connection', '/api/agent/connect', '/api/agent/cancel', '/api/agent/worker'];
    for (const path of paths) {
      const method = path.endsWith('/connection') ? 'GET' as const : 'POST' as const;
      const unauthenticated = await f.app.inject({ method, url: path, headers: { origin }, ...(method === 'POST' ? { payload: {} } : {}) });
      assert.equal(unauthenticated.statusCode, 401, path);
      const untrusted = await f.app.inject({ method, url: path, headers: { ...f.headers, origin: 'https://untrusted.invalid' }, ...(method === 'POST' ? { payload: {} } : {}) });
      assert.equal(untrusted.statusCode, 403, path);
      const crossSite = await f.app.inject({ method, url: path, headers: { ...f.headers, 'sec-fetch-site': 'cross-site' }, ...(method === 'POST' ? { payload: {} } : {}) });
      assert.equal(crossSite.statusCode, 403, path);
      if (method === 'POST') {
        const missingCsrf = await f.app.inject({ method, url: path, headers: { origin, cookie: f.headers.cookie }, payload: {} });
        assert.equal(missingCsrf.statusCode, 403, path);
        const missingOrigin = await f.app.inject({ method, url: path, headers: { cookie: f.headers.cookie, 'x-csrf-token': f.headers['x-csrf-token'] }, payload: {} });
        assert.equal(missingOrigin.statusCode, 403, path);
      }
    }
    assert.equal(f.worker.calls.length, 0, 'Rejected HTTP requests must never reach the worker');
  } finally { await f.dispose(); }
});

test('the administrator can connect and cancel without a task; polling preserves the pending login without persisting it', async () => {
  const f = await fixture();
  try {
    const initial = await f.app.inject({ method: 'GET', url: '/api/agent/connection', headers: f.headers });
    assert.equal(initial.statusCode, 200);
    assert.deepEqual(initial.json(), { state: 'disconnected', workerConnected: true, workerUid: 1234 });
    const started = await f.app.inject({ method: 'POST', url: '/api/agent/connect', headers: f.headers, payload: {} });
    assert.equal(started.statusCode, 200, started.body);
    assert.equal(started.headers['cache-control'], 'no-store');
    assert.equal(started.json().state, 'connecting');
    assert.equal(started.json().verificationUrl, verificationUrl);
    assert.equal(started.json().userCode, userCode);
    assert.equal(started.json().workerUid, 1234);
    assert.equal(f.store.runs().length, 0, 'Login is independent from the durable execution queue');
    assert.deepEqual(f.worker.calls.find(call => call.method === 'agent/connect')?.params, {});
    for (let poll = 0; poll < 2; poll++) {
      const status = await f.app.inject({ method: 'GET', url: '/api/agent/connection', headers: f.headers });
      assert.equal(status.statusCode, 200);
      assert.equal(status.json().userCode, userCode);
      assert.equal(status.json().expiresAt, started.json().expiresAt);
      assert.equal(status.headers['cache-control'], 'no-store');
    }
    assertNoAuthPersistence(f);
    const cancelled = await f.app.inject({ method: 'POST', url: '/api/agent/cancel', headers: f.headers, payload: {} });
    assert.equal(cancelled.statusCode, 200, cancelled.body);
    assert.deepEqual(cancelled.json(), { state: 'disconnected', workerConnected: true, workerUid: 1234 });
    assert.deepEqual(f.worker.calls.find(call => call.method === 'agent/cancel')?.params, {});
    assert.equal(f.store.events().length, 0);
    assertNoAuthPersistence(f);
  } finally { await f.dispose(); }
});

test('queued work waits during login and starts once native connection completion is observed', async () => {
  const f = await fixture();
  try {
    const started = await f.app.inject({ method: 'POST', url: '/api/agent/connect', headers: f.headers, payload: {} });
    assert.equal(started.statusCode, 200, started.body);
    const conversation = f.store.newConversation('Waiting for model access');
    const run = f.store.enqueue(conversation.id, 'Harmless fixture task', 'connection_queued_fixture');
    await f.queue.tick();
    assert.equal(f.store.run(run.id)?.status, 'queued');
    assert.equal(f.worker.submissions.length, 0);
    assertNoAuthPersistence(f);

    f.worker.complete();
    const completed = await f.app.inject({ method: 'GET', url: '/api/agent/connection', headers: f.headers });
    assert.equal(completed.statusCode, 200, completed.body);
    assert.deepEqual(completed.json(), { state: 'connected', workerConnected: true, workerUid: 1234 });
    await eventually(() => f.worker.submissions.length === 1, 'A successful connection must resume the queued task automatically');
    assert.equal(f.worker.submissions[0].runId, run.id);
    assert.equal(f.store.run(run.id)?.status, 'running');
    const status = await f.app.inject({ method: 'GET', url: '/api/status', headers: f.headers });
    assert.equal(status.json().worker.runtime.authenticated, true, 'UI health must refresh after login');
    await f.app.inject({ method: 'GET', url: '/api/agent/connection', headers: f.headers });
    await f.queue.tick();
    assert.equal(f.worker.submissions.length, 1, 'Repeated status polling must never repeat a task');
    assertNoAuthPersistence(f);
  } finally { await f.dispose(); }
});

test('pending login pauses dispatch even if cached runtime credentials still appear authenticated', async () => {
  const f = await fixture();
  try {
    await f.app.inject({ method: 'POST', url: '/api/agent/connect', headers: f.headers, payload: {} });
    f.worker.authenticated = true;
    const conversation = f.store.newConversation();
    const run = f.store.enqueue(conversation.id, 'Hold during credential replacement', 'connection_pending_fixture');
    await f.queue.tick();
    assert.equal(f.worker.authenticating, true);
    assert.equal(f.store.run(run.id)?.status, 'queued');
    assert.equal(f.worker.submissions.length, 0);
  } finally { await f.dispose(); }
});

test('a login started during asynchronous queue preparation prevents submission using stale authenticated health', async () => {
  const f = await fixture();
  let releasePreparation!: () => void;
  const preparation = new Promise<void>(resolve => { releasePreparation = resolve; });
  let preparing = false;
  try {
    f.worker.authenticated = true;
    f.brain.ensureFoundation = async () => { preparing = true; await preparation; };
    const conversation = f.store.newConversation();
    const run = f.store.enqueue(conversation.id, 'Hold after asynchronous preparation', 'connection_preparation_race');
    const tick = f.queue.tick();
    await eventually(() => preparing, 'The queue should reach asynchronous preparation');
    const started = await f.app.inject({ method: 'POST', url: '/api/agent/connect', headers: f.headers, payload: {} });
    assert.equal(started.statusCode, 200, started.body);
    releasePreparation();
    await tick;
    assert.equal(f.store.run(run.id)?.status, 'queued', 'Auth state must be rechecked after asynchronous preparation');
    assert.equal(f.worker.submissions.length, 0);
  } finally { releasePreparation(); await f.dispose(); }
});

test('agent mutation bodies reject client-selected commands, identities and runtime paths', async () => {
  const f = await fixture();
  try {
    for (const path of ['/api/agent/connect', '/api/agent/cancel', '/api/agent/worker']) {
      const response = await f.app.inject({
        method: 'POST', url: path, headers: f.headers,
        payload: { command: '/bin/sh', args: ['-c', 'echo never-executed'], uid: 0, runtimeHome: '/root/.codex', runId: 'untrusted' },
      });
      assert.equal(response.statusCode, 400, path);
    }
    assert.equal(f.worker.calls.length, 0);
    assert.equal(f.store.events().length, 0);
  } finally { await f.dispose(); }
});

test('root-only mode refuses a normal-user worker and supplies a launch command without credentials', async () => {
  const f = await fixture();
  try {
    Object.assign(f.config, { requireRootWorker: true });
    const status = await f.app.inject({ method: 'GET', url: '/api/agent/connection', headers: f.headers });
    assert.equal(status.statusCode, 200, status.body);
    assert.equal(status.json().state, 'error');
    assert.match(status.json().error, /not running as root/i);
    assert.equal(status.json().workerConnected, true);
    assert.equal(status.json().workerUid, f.worker.uid, 'Report the actual normal-user identity');
    const command = status.json().rootWorkerCommand;
    assert.equal(typeof command, 'string');
    assert.ok(command.includes(f.config.stateDir), 'The command must target this configured application state');
    assert.match(command, /src\/(?:root-)?worker\.ts/, 'The command must launch the known project worker');
    for (const secret of [f.config.ipcToken, f.config.adminPassword, userCode]) assert.equal(command.includes(secret), false);
    const refused = await f.app.inject({ method: 'POST', url: '/api/agent/connect', headers: f.headers, payload: {} });
    assert.ok(refused.statusCode >= 400 || refused.json().state === 'error', refused.body);
    assert.equal(f.worker.calls.some(call => call.method === 'agent/connect'), false, 'Root-only login must not configure the normal-user runtime');
    assert.equal(f.worker.calls.some(call => call.method === 'agent/cancel'), false);
    assertNoAuthPersistence(f);
  } finally { await f.dispose(); }
});

test('root-only mode connects the verified UID 0 worker and reports its actual identity', async () => {
  const f = await fixture();
  try {
    Object.assign(f.config, { requireRootWorker: true });
    f.worker.uid = 0;
    const response = await f.app.inject({ method: 'POST', url: '/api/agent/connect', headers: f.headers, payload: {} });
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.json().state, 'connecting');
    assert.equal(response.json().workerUid, 0);
    assert.equal(response.json().userCode, userCode);
    assert.equal(f.worker.calls.some(call => call.method === 'agent/connect'), true);
    assertNoAuthPersistence(f);
  } finally { await f.dispose(); }
});

test('root-only mode keeps tasks queued even when a normal-user worker already has model credentials', async () => {
  const f = await fixture();
  try {
    Object.assign(f.config, { requireRootWorker: true });
    f.worker.authenticated = true;
    const conversation = f.store.newConversation();
    const run = f.store.enqueue(conversation.id, 'Require actual root host access', 'connection_root_required_queue');
    await f.queue.tick();
    assert.equal(f.store.run(run.id)?.status, 'queued');
    assert.equal(f.worker.submissions.length, 0);
    assert.match(f.store.run(run.id)?.blockedReason??'', /root worker|permissions/i);
    assertNoAuthPersistence(f);
  } finally { await f.dispose(); }
});

test('unexpected native credential fields and verification hosts never reach the browser', async () => {
  const f = await fixture();
  try {
    f.worker.connection = {
      state: 'connecting', workerConnected: true, workerUid: 1234,
      verificationUrl, userCode,
      loginId: 'internal-login-id-only', accessToken: 'fixture-access-token-must-stay-private', refreshToken: 'fixture-refresh-token-must-stay-private',
      account: { email: 'private-fixture@example.invalid' },
    };
    const allowed = await f.app.inject({ method: 'GET', url: '/api/agent/connection', headers: f.headers });
    assert.equal(allowed.statusCode, 200, allowed.body);
    assert.equal(allowed.json().state, 'connecting');
    assert.equal(allowed.json().userCode, userCode);
    f.worker.connection.verificationUrl = 'https://auth.openai.com.attacker.invalid/codex/device';
    const refused = await f.app.inject({ method: 'GET', url: '/api/agent/connection', headers: f.headers });
    for (const response of [allowed, refused]) {
      for (const secret of ['fixture-access-token-must-stay-private', 'fixture-refresh-token-must-stay-private', 'internal-login-id-only', 'private-fixture@example.invalid', 'attacker.invalid']) {
        assert.equal(response.body.includes(secret), false, `Response leaked ${secret}`);
      }
    }
    assert.notEqual(refused.json().state, 'connecting', 'A disallowed native verification URL must not be actionable');
    assertNoAuthPersistence(f);
  } finally { await f.dispose(); }
});

test('a missing worker reports a disconnected agent and preserves queued tasks', async () => {
  const f = await fixture();
  try {
    f.worker.online = false;
    const conversation = f.store.newConversation();
    const run = f.store.enqueue(conversation.id, 'Keep until the worker returns', 'connection_disconnected_fixture');
    const response = await f.app.inject({ method: 'GET', url: '/api/agent/connection', headers: f.headers });
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.json().state, 'disconnected');
    assert.equal(response.json().workerConnected, false);
    assert.equal(response.json().workerUid, null);
    assert.equal(response.json().userCode, undefined);
    assert.equal(f.store.run(run.id)?.status, 'queued');
    assert.equal(f.worker.submissions.length, 0);
  } finally { await f.dispose(); }
});

test('root agent execution is admitted without dedicated account or source-protection flags',async()=>{
  const f=await fixture();
  try{
    f.config.requireRootWorker=true;f.worker.uid=0;f.worker.executionUid=0;f.worker.sourceProtected=false;f.worker.complete();
    const conversation=f.store.newConversation(),run=f.store.enqueue(conversation.id,'Run with root and a prompt guardrail','root-prompt-guardrail');
    const status=await f.app.inject({method:'GET',url:'/api/agent/connection',headers:f.headers});
    assert.equal(status.json().state,'connected');assert.equal(status.json().executionUid,0);
    assert.equal(status.json().sourceProtected,undefined);assert.equal(f.worker.submissions.length,1);
    assert.equal(f.store.run(run.id)?.status,'running');
  }finally{await f.dispose();}
});

test('an older root broker with non-root agent execution requires a restart',async()=>{
  const f=await fixture();
  try{
    f.config.requireRootWorker=true;f.worker.uid=0;f.worker.executionUid=2001;f.worker.complete();
    const conversation=f.store.newConversation(),run=f.store.enqueue(conversation.id,'Require actual root execution','legacy-broker-root-migration');
    const status=await f.app.inject({method:'GET',url:'/api/agent/connection',headers:f.headers});
    assert.equal(status.json().state,'error');assert.equal(status.json().executionUid,2001);
    assert.match(status.json().rootWorkerCommand,/APP_STATE_DIR=/);
    assert(!status.json().rootWorkerCommand.includes('APP_EXECUTION_'));assert(!status.json().rootWorkerCommand.includes('APP_PROTECT_OPERATOR'));
    const denied=await f.app.inject({method:'POST',url:'/api/agent/connect',headers:f.headers,payload:{}});
    assert.equal(denied.statusCode,409);await f.queue.tick();assert.equal(f.store.run(run.id)?.status,'queued');assert.equal(f.worker.submissions.length,0);
    const restart=await f.app.inject({method:'POST',url:'/api/agent/worker',headers:f.headers,payload:{}});
    assert.equal(restart.statusCode,409);assert.match(restart.json().error,/Stop it in its terminal/);
  }finally{await f.dispose();}
});

for(const mode of ['different','missing'] as const)test(`connection status exposes setup for ${mode} root-worker project configuration without changing account authentication`,async()=>{
  const f=await fixture();
  try{
    f.worker.uid=0;f.worker.executionUid=0;f.worker.complete();
    const expected=join(f.config.stateDir,'projects'),reported=join(f.config.stateDir,'previous-projects');f.worker.projectsDir=mode==='different'?reported:undefined;
    const status=await f.app.inject({method:'GET',url:'/api/agent/connection',headers:f.headers});assert.equal(status.statusCode,200);assert.equal(status.json().state,'error');assert.equal(status.json().workerSetupRequired,true);assert.equal(status.json().workerUid,0);
    assert(status.json().error.includes(expected));assert(status.json().error.includes(mode==='different'?reported:'unknown (older worker)'));assert(status.json().rootWorkerCommand.includes(`APP_PROJECTS_DIR=${expected}`));assert.match(status.json().error,/current command from Workers/);
    const connect=await f.app.inject({method:'POST',url:'/api/agent/connect',headers:f.headers,payload:{}});assert.equal(connect.statusCode,409);assert.equal(f.worker.authenticated,true);assert.equal(f.worker.calls.some(call=>call.method==='agent/connect'),false);
    assert.equal(f.worker.online,true);assert.equal(f.worker.calls.some(call=>call.method==='worker/reserve-root-replacement'),false);
  }finally{await f.dispose();}
});

for(const busy of ['run','uncertain','operation','login'] as const)test(`the worker launch API refuses replacement during ${busy} activity`,async()=>{
  const f=await fixture();
  try{
    f.worker.uid=0;f.worker.executionUid=0;f.worker.projectsDir=join(f.config.stateDir,'previous-projects');
    if(busy==='run')f.worker.activeRunId='active-run';
    if(busy==='uncertain')f.worker.uncertainRuns=['uncertain-run'];
    if(busy==='operation')f.worker.runtimeOperations=[{id:'runtime_fixture',method:'managed/prepare',status:'running',requiresExternalInspection:false}];
    if(busy==='login')f.worker.authenticating=true;
    const restart=await f.app.inject({method:'POST',url:'/api/agent/worker',headers:f.headers,payload:{}});assert.equal(restart.statusCode,409,restart.body);assert.match(restart.json().error,/Finish or reconcile/);assert.equal(f.worker.online,true);assert.equal(f.worker.calls.some(call=>call.method==='worker/reserve-root-replacement'),false);
  }finally{await f.dispose();}
});

test('worker launch API reuses a matching root worker and emits an explicit fallback project root in generated commands',async()=>{
  const f=await fixture();
  try{
    f.config.requireRootWorker=true;f.worker.uid=0;f.worker.executionUid=0;f.worker.complete();const started=await f.app.inject({method:'POST',url:'/api/agent/worker',headers:f.headers,payload:{}});assert.equal(started.statusCode,200,started.body);assert.equal(started.json().state,'connected');
    f.worker.online=false;const unavailable=await f.app.inject({method:'GET',url:'/api/agent/connection',headers:f.headers});assert.equal(f.config.projectsDir,undefined);assert(unavailable.json().rootWorkerCommand.includes(`APP_PROJECTS_DIR=${join(f.config.stateDir,'projects')}`));
  }finally{await f.dispose();}
});

test('worker launch API reuses the normal user worker without requesting root by default',async()=>{
  const f=await fixture();
  try{
    f.worker.uid=f.config.controllerUid;f.worker.executionUid=f.config.controllerUid;f.worker.complete();
    const started=await f.app.inject({method:'POST',url:'/api/agent/worker',headers:f.headers,payload:{}});assert.equal(started.statusCode,200,started.body);assert.equal(started.json().workerUid,f.config.controllerUid);assert.equal(started.json().state,'connected');
    assert.equal(existsSync(f.config.socketPath),false,'A matching fixture worker must not launch a real process');assert(!f.worker.calls.some(call=>call.method==='worker/reserve-root-replacement'));
    f.worker.online=false;const unavailable=await f.app.inject({method:'GET',url:'/api/agent/connection',headers:f.headers});assert(!unavailable.json().rootWorkerCommand.startsWith("'sudo'"));
  }finally{await f.dispose();}
});
