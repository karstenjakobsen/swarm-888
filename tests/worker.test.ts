import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkerJournal, MAX_WORKER_EVENT_BYTES, WORKER_REPLAY_PAGE_BYTES } from '../src/runtime/journal.js';
import { checkSkill } from '../src/runtime/fixtures.js';
import { EventEmitter, once } from 'node:events';
import { connect } from 'node:net';
import type { Config } from '../src/config.js';
import { WorkerServer } from '../src/worker.js';
import { WorkerClient, type Submission } from '../src/ipc.js';
import { bootId, processStamp, groupMembers } from '../src/runtime/processes.js';
import { spawn } from 'node:child_process';

test('worker acceptance is durable and idempotent, and outbox replay preserves cursor order', () => {
  const directory = mkdtempSync(join(tmpdir(), 'operator-journal-')); let journal = new WorkerJournal(directory, 3);
  const run = { runId: 'one', conversationId: 'c', prompt: 'fixture', cwd: directory, bootstrap: '', skills: [] };
  try {
    assert.equal(journal.accept(run), true); assert.equal(journal.accept(run), false);
    const first = journal.append('one', 'status', { status: 'running' }); const second = journal.append('one', 'delta', { text: 'x' });
    journal.child('one', 123, '456', 'boot'); journal.close(); journal = new WorkerJournal(directory, 3);
    assert.deepEqual(journal.replay(0).map(event => event.cursor), [first.cursor, second.cursor]); assert.equal(journal.get('one')?.child_start, '456');
    journal.append('one', 'delta', { text: 'y' }); assert.throws(() => journal.append('one', 'delta', { text: 'z' }), /outbox is full/);
    journal.acknowledge(second.cursor); assert.equal(journal.replay(second.cursor).length, 1); assert.equal(journal.replay(0).length, 1);
    const terminal = journal.append('one', 'completed', { status: 'completed' }, true); assert(terminal.cursor > second.cursor);
    journal.status('one', 'completed'); assert.equal(journal.active().length, 0);
  } finally { journal.close(); rmSync(directory, { recursive: true, force: true }); }
});
test('a journal larger than one IPC frame replays bounded ordered pages without dropping output', () => {
  const directory = mkdtempSync(join(tmpdir(), 'operator-paged-outbox-')); const journal = new WorkerJournal(directory);
  try {
    journal.accept({ runId: 'large', conversationId: 'c', prompt: 'fixture', cwd: directory, bootstrap: '', skills: [] });
    const payload = 'é'.repeat((MAX_WORKER_EVENT_BYTES - 1024) / 2);
    const cursors = Array.from({ length: 20 }, (_, index) => journal.append('large', 'activity', { index, output: payload }).cursor);
    assert(journal.bytes() > 16 * 1024 * 1024);
    let cursor = 0; const recovered: number[] = []; let pages = 0;
    while (true) {
      const page = journal.replayPage(cursor); pages++; assert(Buffer.byteLength(JSON.stringify(page.events)) <= WORKER_REPLAY_PAGE_BYTES); assert(page.events.length <= 500);
      assert(page.nextCursor > cursor); for (const event of page.events) { assert.equal((event.data as any).output, payload); recovered.push(event.cursor); }
      cursor = page.nextCursor; if (!page.hasMore) break;
    }
    assert(pages > 1); assert.deepEqual(recovered, cursors); journal.acknowledge(cursor); assert.equal(journal.count(), 0);
    assert.throws(() => journal.append('large', 'activity', { output: 'x'.repeat(MAX_WORKER_EVENT_BYTES) }), /exceeded 1 MiB/);
    journal.append('large', 'completed', { status: 'failed', error: 'Oversized output was rejected explicitly' }, true); assert.equal(journal.replayPage(cursor).events.length, 1);
  } finally { journal.close(); rmSync(directory, { recursive: true, force: true }); }
});
test('representative skill validation executes a helper with fresh fixtures and compares real outputs', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'operator-skill-check-')); const candidate = join(directory, 'candidate'); mkdirSync(candidate);
  writeFileSync(join(candidate, 'report.mjs'), "import{readFileSync,writeFileSync}from'node:fs';const n=JSON.parse(readFileSync('input.json','utf8'));writeFileSync('report.txt',String(n.a+n.b));console.log('done');");
  try {
    const result = await checkSkill(directory, { candidatePath: candidate, checks: [{ name: 'sum', command: process.execPath, args: ['{skill}/report.mjs'], fixtures: { 'input.json': '{"a":2,"b":5}' }, expectedStdout: 'done\n', expectedFiles: { 'report.txt': '7' } }] });
    assert.equal(result.passed, true); assert.equal(result.checks[0]?.exitCode, 0);
    const failing = await checkSkill(directory, { candidatePath: candidate, checks: [{ name: 'wrong result', command: process.execPath, args: ['{skill}/report.mjs'], fixtures: { 'input.json': '{"a":2,"b":5}' }, expectedFiles: { 'report.txt': '8' } }] });
    assert.equal(failing.passed, false); assert.match(failing.checks[0]?.error ?? '', /did not match/);
    const traversal = await checkSkill(directory, { candidatePath: candidate, checks: [{ name: 'unsafe fixture', command: process.execPath, args: [], fixtures: { '../escape': 'bad' } }] }); assert.equal(traversal.passed, false);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
test('helper cannot execute if recording its process identity fails before the start handshake', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'operator-helper-handshake-')); const candidate = join(directory, 'candidate'); mkdirSync(candidate); const sideEffect = join(directory, 'must-not-exist');
  writeFileSync(join(candidate, 'helper.mjs'), "import{writeFileSync}from'node:fs';writeFileSync(process.argv[2],'executed');console.log('executed');");
  try {
    const result = await checkSkill(directory, { candidatePath: candidate, checks: [{ name: 'handshake', command: process.execPath, args: ['{skill}/helper.mjs', sideEffect], fixtures: {}, expectedStdout: 'executed\n' }] }, { spawned: () => { throw new Error('Simulated journal persistence failure'); } });
    assert.equal(result.passed, false); assert.match(result.checks[0]?.error ?? '', /journal persistence failure/); assert.equal(existsSync(sideEffect), false);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
test('a completed helper does not leave attached descendants executing before another run', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'operator-helper-tree-')); const candidate = join(directory, 'candidate'); mkdirSync(candidate); let group = 0;
  writeFileSync(join(candidate, 'helper.mjs'), "import{spawn}from'node:child_process';const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});child.unref();console.log('done');");
  try {
    const result = await checkSkill(directory, { candidatePath: candidate, checks: [{ name: 'tree cleanup', command: process.execPath, args: ['{skill}/helper.mjs'], fixtures: {}, expectedStdout: 'done\n' }] }, { spawned: pid => { group = pid; } });
    assert.equal(result.passed, true); assert(group > 0); assert.equal(groupMembers(group).length, 0);
  } finally { if (group) try { process.kill(-group, 'SIGKILL'); } catch {} rmSync(directory, { recursive: true, force: true }); }
});

class FixtureAdapter extends EventEmitter {
  version = '0.166.0'; threadId = 'fixture-thread'; turnId?: string; timer?: NodeJS.Timeout;
  async start() {}
  async health() { return { authenticated: true, detail: 'Explicit test double' }; }
  async run(submission: Submission) {
    this.turnId = 'fixture-turn'; this.emit('event', 'thread', { threadId: this.threadId });
    this.timer = setTimeout(() => { this.emit('event', 'delta', { text: submission.prompt, itemId: 'a' }); this.emit('event', 'completed', { status: 'completed' }); }, 150);
  }
  async interrupt() { clearTimeout(this.timer); this.emit('event', 'completed', { status: 'interrupted' }); }
  reply() {}
  async close() { clearTimeout(this.timer); }
}
function workerConfig(directory: string): Config {
  for (const name of ['worker', 'skills', 'workspaces', 'runtime', 'artifacts']) mkdirSync(join(directory, name));
  return { stateDir: directory, runtimeHome: join(directory, 'runtime'), socketPath: join(directory, 'worker.sock'), bridgeSocket: join(directory, 'bridge.sock'), ipcToken: 'b'.repeat(64), controllerUid: process.getuid!(), codexBin: '', host: '127.0.0.1', port: 3001, origins: [], adminPassword: '', secureCookie: false, improvementEnabled: false, improvementTimeoutMs: 1000, improvementMaxTurns: 1, allowTempState: true };
}
test('private worker authenticates IPC, serializes runs and replays a run completed while disconnected', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'operator-worker-')); const config = workerConfig(directory);
  const worker = new WorkerServer(config, () => new FixtureAdapter() as any); const client = new WorkerClient(config); let second: WorkerClient | undefined;
  try {
    await worker.listen(); const unauthorized = connect(config.socketPath); await once(unauthorized, 'connect'); unauthorized.write(JSON.stringify({ id: 1, method: 'hello', params: { token: 'c'.repeat(64) } }) + '\n');
    const response = await once(unauthorized, 'data'); assert.match(response[0].toString(), /authentication failed/); unauthorized.destroy();
    const health = await client.connect(); assert.equal(health.uid, process.getuid!()); assert.equal(health.root, process.getuid!() === 0);
    const run = { runId: 'r1', conversationId: 'c1', prompt: 'durable fixture', cwd: join(directory, 'workspaces/c1'), bootstrap: '', skills: [] };
    assert.equal((await client.request('submit', run)).duplicate, false); assert.equal((await client.request('submit', run)).duplicate, true);
    await assert.rejects(client.request('submit', { ...run, prompt: 'different request for the same run' }), /already accepted with different input/);
    await assert.rejects(client.request('submit', { ...run, runId: 'r2' }), /occupied/);
    client.close(); await new Promise(resolveWait => setTimeout(resolveWait, 250));
    second = new WorkerClient(config); await second.connect(); const snapshot = await second.request('sync', { after: 0 });
    assert.equal(snapshot.activeRunId, null); assert(snapshot.events.some((event: any) => event.type === 'delta' && event.data.text === 'durable fixture')); assert(snapshot.events.some((event: any) => event.type === 'completed'));
    assert.deepEqual(snapshot.events.map((event: any) => event.cursor), [...snapshot.events.map((event: any) => event.cursor)].sort((a, b) => a - b));
    await second.request('acknowledge', { cursor: snapshot.events.at(-1).cursor }); assert.equal((await second.request('sync', { after: 0 })).events.length, 0);
  } finally { client.close(); second?.close(); await worker.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('concurrent client connections share one authenticated handshake', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'operator-ipc-concurrent-')); const config = workerConfig(directory);
  const worker = new WorkerServer(config, () => new FixtureAdapter() as any); const client = new WorkerClient(config);
  try {
    await worker.listen();
    const connections = await Promise.all([client.connect(), client.connect(), client.connect()]);
    assert.deepEqual(connections[1], connections[0]); assert.deepEqual(connections[2], connections[0]);
    assert.equal((await client.request('health')).connected, true);
  } finally { client.close(); await worker.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('closing a previous client socket does not disconnect a replacement connection', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'operator-ipc-reconnect-')); const config = workerConfig(directory);
  const worker = new WorkerServer(config, () => new FixtureAdapter() as any); const client = new WorkerClient(config); let disconnects = 0;
  client.on('disconnect', () => { disconnects++; });
  try {
    await worker.listen(); await client.connect();
    for (let attempt = 0; attempt < 5; attempt++) {
      client.close(); assert.equal((await client.connect()).connected, true);
      assert.equal((await client.request('health')).connected, true);
    }
    assert.equal(disconnects, 0, 'Retired sockets must not announce that the current connection disconnected');
  } finally { client.close(); await worker.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('oversized final output fails explicitly rather than reporting a completed run with missing text', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'operator-final-output-')); const config = workerConfig(directory);
  class OversizedFinalAdapter extends FixtureAdapter {
    async run() {
      this.emit('event', 'delta', { itemId: 'large-final', text: 'x'.repeat(MAX_WORKER_EVENT_BYTES) });
      this.emit('event', 'completed', { status: 'completed' });
    }
  }
  const worker = new WorkerServer(config, () => new OversizedFinalAdapter() as any); const client = new WorkerClient(config);
  try {
    await worker.listen(); await client.connect();
    const completed = new Promise<any>(resolveDone => client.on('event', event => { if (event.type === 'completed') resolveDone(event.data); }));
    await client.request('submit', { runId: 'large-final', conversationId: 'c', prompt: 'fixture', cwd: join(directory, 'workspaces/c'), bootstrap: '', skills: [] });
    const result = await completed;
    assert.equal(result.status, 'failed'); assert.match(result.error, /exceeded 1 MiB/);
    assert.equal(worker.journal.get('large-final')?.status, 'failed');
  } finally { client.close(); await worker.close(); rmSync(directory, { recursive: true, force: true }); }
});
test('private-socket sync recovers more than 16 MiB through bounded pages before acknowledging', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'operator-wire-pages-')); const config = workerConfig(directory); const journal = new WorkerJournal(directory);
  journal.accept({ runId: 'wire', conversationId: 'c', prompt: 'fixture', cwd: join(directory, 'workspaces/c'), bootstrap: '', skills: [] });
  const payload = 'x'.repeat(MAX_WORKER_EVENT_BYTES - 1024);
  for (let index = 0; index < 20; index++) journal.append('wire', 'activity', { index, output: payload }); journal.status('wire', 'completed'); journal.close();
  const worker = new WorkerServer(config, () => new FixtureAdapter() as any); const client = new WorkerClient(config);
  try {
    await worker.listen(); await client.connect(); let cursor = 0; const indexes: number[] = [];
    while (true) {
      const page = await client.request('sync', { after: cursor }); assert(Buffer.byteLength(JSON.stringify(page)) < 16 * 1024 * 1024); assert(page.nextCursor > cursor);
      for (const event of page.events) { assert.equal(event.data.output, payload); indexes.push(event.data.index); }
      cursor = page.nextCursor; if (!page.hasMore) break;
    }
    assert.deepEqual(indexes, Array.from({ length: 20 }, (_, index) => index)); await client.request('acknowledge', { cursor }); assert.equal((await client.request('sync', { after: cursor })).events.length, 0);
  } finally { client.close(); await worker.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('worker startup preserves uncertain acceptance and requires orphan resolution before another run', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'operator-orphan-')); const config = workerConfig(directory);
  const journal = new WorkerJournal(directory); const run = { runId: 'lost', conversationId: 'c1', prompt: 'do not repeat', cwd: join(directory, 'workspaces/c1'), bootstrap: '', skills: [] }; journal.accept(run); journal.status(run.runId, 'running'); journal.close();
  const worker = new WorkerServer(config, () => new FixtureAdapter() as any); const client = new WorkerClient(config);
  try {
    await worker.listen(); const health = await client.connect(); assert.deepEqual(health.uncertainRuns, ['lost']);
    await assert.rejects(client.request('submit', { ...run, runId: 'new' }), /unresolved orphan/);
    await client.request('resolve', { runId: 'lost' }); assert.equal((await client.request('health')).uncertainRuns.length, 0);
    const snapshot = await client.request('sync', { after: 0 }); assert(snapshot.events.some((event: any) => event.type === 'completed' && event.data.status === 'failed'));
  } finally { client.close(); await worker.close(); rmSync(directory, { recursive: true, force: true }); }
});
test('standalone representative-check acceptance survives worker restart and blocks execution until resolved', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'operator-check-orphan-')); const config = workerConfig(directory);
  const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { detached: true, stdio: 'ignore' }); await once(child, 'spawn');
  const journal = new WorkerJournal(directory); journal.beginCheck('fixture_orphan', null, join(directory, 'skills/candidate')); journal.checkChild('fixture_orphan', child.pid!, processStamp(child.pid!)!, bootId()); journal.close();
  const worker = new WorkerServer(config, () => new FixtureAdapter() as any); const client = new WorkerClient(config);
  try {
    await worker.listen(); assert.deepEqual((await client.connect()).uncertainRuns, ['fixture_orphan']);
    await assert.rejects(client.request('submit', { runId: 'new', conversationId: 'c', prompt: 'fixture', cwd: join(directory, 'workspaces/c'), bootstrap: '', skills: [] }), /orphan/);
    assert.equal((await client.request('resolve', { runId: 'fixture_orphan' })).kind, 'skillCheck'); assert.deepEqual((await client.request('health')).uncertainRuns, []);
    assert.equal(groupMembers(child.pid!).length, 0, 'Resolution must stop the verified owned helper process group');
    assert.equal((await client.request('sync', { after: 0 })).events.length, 0, 'Auxiliary resolution must not inject an event for a nonexistent controller run');
  } finally { try { process.kill(-child.pid!, 'SIGKILL'); } catch {} client.close(); await worker.close(); rmSync(directory, { recursive: true, force: true }); }
});
test('worker redacts escaped configured secrets and a secret split across streamed flushes', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'operator-redaction-')); const config = workerConfig(directory); config.adminPassword = 'quoted"secret\\with\nnewline'; const secret = config.adminPassword;
  class SecretFixture extends FixtureAdapter {
    async run() { this.turnId = 'fixture'; this.emit('event', 'activity', { value: secret }); this.emit('event', 'delta', { itemId: 'a', text: 'before ' + secret.slice(0, 9) }); this.timer = setTimeout(() => { this.emit('event', 'delta', { itemId: 'a', text: secret.slice(9) + ' after' }); this.emit('event', 'completed', { status: 'completed' }); }, 100); }
  }
  const worker = new WorkerServer(config, () => new SecretFixture() as any); const client = new WorkerClient(config);
  try {
    await worker.listen(); await client.connect(); const completed = new Promise<void>(resolveDone => client.on('event', event => { if (event.type === 'completed') resolveDone(); }));
    await client.request('submit', { runId: 'redact', conversationId: 'c', prompt: 'fixture', cwd: join(directory, 'workspaces/c'), bootstrap: '', skills: [] }); await completed;
    const snapshot = await client.request('sync', { after: 0 }); const deltas = snapshot.events.filter((event: any) => event.type === 'delta').map((event: any) => event.data.text).join('');
    assert.equal(deltas, 'before [REDACTED] after'); assert.equal(snapshot.events.find((event: any) => event.type === 'activity').data.value, '[REDACTED]');
    assert(!JSON.stringify(snapshot).includes(JSON.stringify(secret).slice(1, -1)));
  } finally { client.close(); await worker.close(); rmSync(directory, { recursive: true, force: true }); }
});
test('a configured credential resembling JSON syntax cannot corrupt event structure', { timeout: 5000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'operator-json-redaction-')); const config = workerConfig(directory); config.adminPassword = 'status":"completed';
  const worker = new WorkerServer(config, () => new FixtureAdapter() as any); const client = new WorkerClient(config);
  try {
    await worker.listen(); await client.connect(); const completed = new Promise<void>(resolveDone => client.on('event', event => { if (event.type === 'completed') { assert.equal((event.data as any).status, 'completed'); resolveDone(); } }));
    await client.request('submit', { runId: 'redact-json', conversationId: 'c', prompt: config.adminPassword, cwd: join(directory, 'workspaces/c'), bootstrap: '', skills: [] }); await completed;
    const snapshot = await client.request('sync', { after: 0 }); assert.equal(snapshot.events.find((event: any) => event.type === 'delta').data.text, '[REDACTED]');
  } finally { client.close(); await worker.close(); rmSync(directory, { recursive: true, force: true }); }
});
