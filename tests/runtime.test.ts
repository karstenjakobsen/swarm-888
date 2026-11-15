import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Config } from '../src/config.js';
import { CodexAdapter } from '../src/runtime/codex.js';
import { createController } from '../src/controller.ts';
import { WorkerServer } from '../src/worker.ts';
import { spawn } from 'node:child_process';

test('a request without a connected adapter rejects without leaving a timeout alive', { timeout: 5000 }, async () => {
  const source = `import { CodexAdapter } from ${JSON.stringify(new URL('../src/runtime/codex.ts', import.meta.url).href)};
    const adapter = new CodexAdapter({});
    try { await adapter.request('health', {}); process.exitCode = 1; }
    catch (error) { console.log(error.message); }`;
  const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', source], { stdio: ['ignore', 'pipe', 'pipe'] });
  let output = ''; child.stdout.on('data', data => { output += data.toString(); });
  try {
    const [code] = await once(child, 'exit');
    assert.equal(code, 0); assert.match(output, /not connected/);
  } finally { if (child.exitCode === null) child.kill('SIGKILL'); }
});

const fixture = `#!/usr/bin/env node
import readline from 'node:readline';
if(process.argv.includes('--version')) { console.log('codex-cli 0.166.0'); process.exit(0); }
const send=x=>process.stdout.write(JSON.stringify(x)+'\\n');
let turn='turn-1';
readline.createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line); if(!m.method)return;
 const result=m.method==='account/read'?{account:{type:'apiKey'},requiresOpenaiAuth:true}:
 ['thread/start','thread/resume'].includes(m.method)?{thread:{id:'thread-1'},approvalPolicy:m.params.approvalPolicy,sandbox:{type:'dangerFullAccess'},model:'fixture-model'}:
 m.method==='skills/list'?{data:[{skills:[],errors:[]}]}:m.method==='turn/start'?{turn:{id:turn}}:{};
 if(m.id!==undefined)send({id:m.id,result});
 if(m.method==='turn/start'){
  const text=m.params.input[0].text;
  if(text==='budget')setTimeout(()=>send({method:'item/started',params:{threadId:'thread-1',turnId:turn,item:{id:'tool1',type:'commandExecution',command:'fixture'}}}),20);
  else if(text==='clarify')send({id:500,method:'item/tool/requestUserInput',params:{threadId:'thread-1',turnId:turn,itemId:'q1',questions:[{id:'target',header:'Target',question:'Which target?',isSecret:false,options:null}],isBlocking:true}});
  else if(text!=='wait')setTimeout(()=>{
   send({method:'item/agentMessage/delta',params:{threadId:'thread-1',turnId:turn,itemId:'a1',delta:'Real protocol fixture response'}});
   send({method:'item/completed',params:{threadId:'thread-1',turnId:turn,item:{type:'commandExecution',command:'printf fixture',exitCode:0}}});
   send({method:'turn/completed',params:{threadId:'thread-1',turn:{id:turn,status:'completed',error:null}}});
  },30);
 }
 if(m.method==='turn/interrupt')send({method:'turn/completed',params:{threadId:'thread-1',turn:{id:turn,status:'interrupted',error:null}}});
});
`;
function setup(): { config: Config; directory: string } {
  const directory = mkdtempSync(join(tmpdir(), 'operator-protocol-')); const codexBin = join(directory, 'fake-codex.mjs'); writeFileSync(codexBin, fixture, { mode: 0o700 });
  return { directory, config: { stateDir: directory, runtimeHome: join(directory, 'runtime'), socketPath: join(directory, 'worker.sock'), bridgeSocket: join(directory, 'bridge.sock'), ipcToken: 'a'.repeat(64), controllerUid: process.getuid!(), codexBin, model: undefined, host: '127.0.0.1', port: 3001, origins: [], adminPassword: '', secureCookie: false, improvementEnabled: false, improvementTimeoutMs: 1000, improvementMaxTurns: 1, allowTempState: true } };
}
test('adapter handles generated-protocol lifecycle, deltas, and observed interruption', async () => {
  const { config, directory } = setup(); const adapter = new CodexAdapter(config, 'run-1');
  try {
    await adapter.start(); assert.equal((await adapter.health()).authenticated, true);
    const events: Array<{ type: string; data: any }> = []; adapter.on('event', (type, data) => events.push({ type, data }));
    const completed = new Promise<void>(resolve => adapter.on('event', type => { if (type === 'completed') resolve(); }));
    await adapter.run({ runId: 'run-1', conversationId: 'c1', prompt: 'hello', cwd: directory, bootstrap: 'fixture', skills: [] }); await completed;
    assert.equal(adapter.threadId, 'thread-1'); assert(events.some(event => event.type === 'delta' && event.data.text === 'Real protocol fixture response')); assert(events.some(event => event.type === 'completed' && event.data.status === 'completed'));
    const interrupted = new Promise<void>(resolve => adapter.on('event', (type, data) => { if (type === 'completed' && data.status === 'interrupted') resolve(); }));
    await adapter.run({ runId: 'run-1', conversationId: 'c1', threadId: 'thread-1', prompt: 'wait', cwd: directory, bootstrap: '', skills: [] }); await adapter.interrupt(); await interrupted;
  } finally { await adapter.close(); rmSync(directory, { recursive: true, force: true }); }
});
test('adapter forwards clarification request and replies to the same JSON-RPC request', async () => {
  const { config, directory } = setup(); const adapter = new CodexAdapter(config, 'run-2');
  try {
    await adapter.start(); const question = new Promise<any>(resolve => adapter.on('event', (type, data) => { if (type === 'clarification') resolve(data); }));
    await adapter.run({ runId: 'run-2', conversationId: 'c2', prompt: 'clarify', cwd: directory, bootstrap: '', skills: [] });
    const input = await question; assert.equal(input.requestId, '500'); assert.equal(input.questions[0].id, 'target');
    adapter.reply(input.requestId, { target: 'local fixture' }); assert.throws(() => adapter.reply(input.requestId, {}), /no longer pending/);
  } finally { await adapter.close(); rmSync(directory, { recursive: true, force: true }); }
});
test('installed Codex reports missing credentials, effective unrestricted policy and real skill discovery', { timeout: 30_000 }, async () => {
  const { config, directory } = setup(); config.codexBin = join(process.cwd(), 'node_modules/.bin/codex');
  const adapter = new CodexAdapter(config);
  try {
    await adapter.start(); assert.equal(adapter.version, '0.166.0'); const health = await adapter.health();
    assert.equal(health.authenticated, false); assert.match(health.detail, /authentication missing/);
    const cwd = join(directory, 'workspace'); const skill = join(cwd, '.agents/skills/operator-test-report'); mkdirSync(skill, { recursive: true });
    writeFileSync(join(skill, 'SKILL.md'), '---\nname: operator-test-report\ndescription: Generate a deterministic report from fixture data for protocol verification.\n---\nUse the provided fixture data to generate a report.\n');
    const started = await adapter.request('thread/start', { cwd, approvalPolicy: 'never', sandbox: 'danger-full-access' });
    assert.equal(started.approvalPolicy, 'never'); assert.equal(started.sandbox.type, 'dangerFullAccess');
    const discovered = await adapter.request('skills/list', { cwds: [cwd], forceReload: true });
    assert(discovered.data.flatMap((entry: any) => entry.skills).some((entry: any) => entry.name === 'operator-test-report' && entry.enabled));
  } finally { await adapter.close(); rmSync(directory, { recursive: true, force: true }); }
});
test('a separate improvement run is interrupted at its observed tool-call budget', async () => {
  const { config, directory } = setup(); const adapter = new CodexAdapter(config, 'improve-1');
  try {
    await adapter.start(); const events: Array<{ type: string; data: any }> = []; adapter.on('event', (type, data) => events.push({ type, data }));
    const completed = new Promise<any>(resolve => adapter.on('event', (type, data) => { if (type === 'completed') resolve(data); }));
    await adapter.run({ runId: 'improve-1', conversationId: 'c1', prompt: 'budget', cwd: directory, bootstrap: '', skills: [], kind: 'improvement' });
    assert.equal((await completed).status, 'interrupted'); assert(events.some(event => event.data.method === 'operator/improvementBudget' && event.data.observed === 1));
  } finally { await adapter.close(); rmSync(directory, { recursive: true, force: true }); }
});
test('real app-server discovers the stdio MCP bridge and returns durable application tool results', { timeout: 30_000 }, async () => {
  const { config, directory } = setup(); config.codexBin = join(process.cwd(), 'node_modules/.bin/codex');
  for (const name of ['skills', 'workspaces', 'artifacts', 'worker']) mkdirSync(join(directory, name));
  const controller = await createController(config, { startQueue: false });
  const c = controller.store.newConversation('Real MCP protocol verification'); const run = controller.store.enqueue(c.id, 'protocol fixture only; no model request', 'real_mcp_protocol_fixture'); controller.store.transition(run.id, 'running');
  const adapter = new CodexAdapter(config, run.id);
  try {
    await adapter.start(); const started = await adapter.request('thread/start', { cwd: directory, approvalPolicy: 'never', sandbox: 'danger-full-access' }); const threadId = started.thread.id;
    const servers = await adapter.request('mcpServerStatus/list', { threadId, serverName: 'operator', detail: 'toolsAndAuthOnly' });
    assert(JSON.stringify(servers).includes('memory_write'), `Real Codex did not discover the application MCP tools: ${JSON.stringify(servers)}`);
    const written = await adapter.request('mcpServer/tool/call', { threadId, server: 'operator', tool: 'memory_write', arguments: { content: 'Real MCP bridge fixture fact', kind: 'user_fact', source: 'native-protocol integration check' } });
    assert(!written.isError, JSON.stringify(written));
    assert.equal(controller.brain.memorySearch('bridge fixture').length, 1);
    const searched = await adapter.request('mcpServer/tool/call', { threadId, server: 'operator', tool: 'memory_search', arguments: { query: 'bridge fixture' } }); assert(JSON.stringify(searched).includes('Real MCP bridge fixture fact'));
    // This exercises real Codex -> stdio MCP -> authenticated socket -> SQLite -> same
    // protocol call. It deliberately does not claim a model-initiated tool call.
  } finally { await adapter.close(); await controller.close(); rmSync(directory, { recursive: true, force: true }); }
});
test('credential-required live acceptance script stops before creating runs when model auth is missing', { timeout: 30_000 }, async () => {
  const { config, directory } = setup(); config.codexBin = join(process.cwd(), 'node_modules/.bin/codex'); config.adminPassword = 'live-smoke-test-credential'; config.origins = ['http://localhost:5173'];
  for (const name of ['skills', 'workspaces', 'artifacts', 'worker', 'runtime', 'secrets']) mkdirSync(join(directory, name));
  writeFileSync(join(directory, 'secrets/ipc-token'), config.ipcToken, { mode: 0o600 });
  const worker = new WorkerServer(config); await worker.listen(); const controller = await createController(config);
  try {
    const url = await controller.app.listen({ host: '127.0.0.1', port: 0 });
    const result = await new Promise<{ code: number | null; output: string }>((finish, reject) => {
      const child = spawn(process.execPath, ['--import', 'tsx', 'scripts/live-smoke.ts'], { cwd: process.cwd(), env: { ...process.env, APP_STATE_DIR: directory, APP_ALLOW_TEMP_STATE: 'true', APP_SMOKE_URL: url, ADMIN_PASSWORD: config.adminPassword, APP_CONTROLLER_UID: String(config.controllerUid) }, stdio: ['ignore', 'pipe', 'pipe'] });
      let output = ''; child.stdout.on('data', data => output += data.toString()); child.stderr.on('data', data => output += data.toString()); child.once('error', reject); child.once('exit', code => finish({ code, output }));
    });
    assert.equal(result.code, 1); assert.match(result.output, /Real worker\/model authentication is required/); assert(!result.output.includes(config.adminPassword)); assert.equal(controller.store.runs().length, 0);
  } finally { await controller.close(); await worker.close(); rmSync(directory, { recursive: true, force: true }); }
});
