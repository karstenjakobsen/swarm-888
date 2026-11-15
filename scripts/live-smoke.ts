/** Credential-required acceptance checks against an already running real controller and worker.
 * This script never supplies a fake runtime, changes login profiles, or launches a root controller.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from '../src/config.ts';
import type { AppEvent, Run } from '../src/shared.ts';

const config = loadConfig({ requireAdmin: true });
const base = process.env.APP_SMOKE_URL ?? `http://127.0.0.1:${config.port}`;
const origin = config.origins[0]!;
const timeoutMs = Number(process.env.APP_SMOKE_TIMEOUT_MS ?? 600_000);
const terminal = new Set(['completed', 'failed', 'interrupted', 'uncertain']);
let cookie = ''; let csrf = '';
const pause = (ms: number) => new Promise(resolveWait => setTimeout(resolveWait, ms));
async function api(path: string, body?: unknown, method = body === undefined ? 'GET' : 'POST'): Promise<any> {
  const response = await fetch(base + path, { method, headers: { origin, cookie, ...(body === undefined ? {} : { 'content-type': 'application/json', 'x-csrf-token': csrf }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30_000) });
  const value: any = await response.json(); if (!response.ok) throw new Error(`${method} ${path}: ${value.error ?? response.status}`);
  if (path === '/api/login') { cookie = response.headers.get('set-cookie')!.split(';')[0]!; csrf = value.csrfToken; }
  return value;
}
async function conversation(title: string) { return api('/api/conversations', { title }); }
async function submit(id: string, prompt: string): Promise<Run> { return api(`/api/conversations/${id}/runs`, { prompt, requestId: randomUUID() }); }
async function waitForRun(run: Run, expected = 'completed'): Promise<any> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const history = await api(`/api/conversations/${run.conversationId}`); const current = history.runs.find((candidate: Run) => candidate.id === run.id);
    if (current?.status === 'waiting') throw new Error(`Run ${run.id} requested clarification. Answer it in the web UI, then retry the relevant check.`);
    if (current && terminal.has(current.status)) { assert.equal(current.status, expected, `Live run ${run.id} failed: ${current.error ?? current.status}`); return history; }
    await pause(1000);
  }
  throw new Error(`Timed out waiting for live run ${run.id}; it may still be executing. Inspect the UI before retrying.`);
}
function called(history: any, runId: string, name: string): boolean { return history.events.some((event: AppEvent) => event.runId === runId && event.type === 'tool' && (event.data as any).name === name); }
async function prompt(id: string, text: string, tools: string[] = []) {
  const run = await submit(id, text); const history = await waitForRun(run);
  for (const tool of tools) assert(called(history, run.id, tool), `Run ${run.id} did not call real operator tool ${tool}`);
  console.log(`PASS real agent run ${run.id}: ${tools.join(', ') || 'host execution'}`);
  return { run, history };
}
async function sseUntil(after: number, predicate: (event: AppEvent) => boolean): Promise<AppEvent[]> {
  const abort = new AbortController(); const timer = setTimeout(() => abort.abort(), timeoutMs); const events: AppEvent[] = [];
  try {
    const response = await fetch(base + `/api/events?after=${after}`, { headers: { cookie, origin }, signal: abort.signal }); assert.equal(response.status, 200);
    const reader = response.body!.getReader(); const decoder = new TextDecoder(); let buffer = ''; let cursor = after;
    while (true) {
      const result = await reader.read(); if (result.done) throw new Error('SSE ended before the expected event'); buffer += decoder.decode(result.value, { stream: true });
      let end: number;
      while ((end = buffer.indexOf('\n\n')) >= 0) {
        const frame = buffer.slice(0, end); buffer = buffer.slice(end + 2); if (!frame.includes('event: event')) continue;
        const data = frame.split('\n').find(line => line.startsWith('data: ')); if (!data) continue; const event = JSON.parse(data.slice(6)) as AppEvent;
        assert(event.seq > cursor, 'Reconnected SSE displayed a duplicate/out-of-order event'); cursor = event.seq; events.push(event);
        if (predicate(event)) { await reader.cancel(); return events; }
      }
    }
  } finally { clearTimeout(timer); abort.abort(); }
}
type Manifest = { id: string; factKey: string; factValue: string; skillName: string; activeVersion: number };
const manifestPath = join(config.stateDir, 'artifacts/live-smoke-manifest.json');

async function retrieveAndUse(manifest: Manifest, suffix: string) {
  const c = await conversation(`Live smoke ${suffix} ${manifest.id}`); const output = join(config.stateDir, `artifacts/smoke-${manifest.id}/${suffix}.json`); const input = join(config.stateDir, `artifacts/smoke-${manifest.id}/${suffix}-input.json`);
  writeFileSync(input, JSON.stringify({ values: [3, 5, 9] }));
  const { run, history } = await prompt(c.id,
    `This is a fresh conversation. Retrieve the acceptance fact identified by ${manifest.factKey} using memory_search and memory_get. Do not guess or infer its value. Then explicitly use $${manifest.skillName}: discover/read its installed SKILL.md and execute its report helper against ${input}, writing ${output}. Use the installed skill, not a replacement script. Record an honest skill_outcome with the observed result. Finish by stating the retrieved fact.`,
    ['memory_search', 'memory_get', 'skill_outcome']);
  assert(history.messages.some((message: any) => message.runId === run.id && message.role === 'assistant' && message.content.includes(manifest.factValue)), 'Fresh conversation did not return the remembered unique fact');
  assert.deepEqual(JSON.parse(readFileSync(output, 'utf8')), manifest.activeVersion === 1 ? { total: 17 } : { total: 17, count: 3 });
  const discovered = history.events.find((event: AppEvent) => event.runId === run.id && event.type === 'skills');
  assert((discovered?.data as any)?.loaded.some((skill: any) => skill.name === manifest.skillName && Number(skill.version) === manifest.activeVersion), 'Runtime did not discover the expected installed version');
  const commands = history.events.filter((event: AppEvent) => event.runId === run.id && event.type === 'activity').map((event: AppEvent) => JSON.stringify(event.data)).join('\n');
  assert(commands.includes('scripts/report.mjs'), 'Execution records do not show use of the installed helper');
  console.log(`PASS ${suffix}: independent report output, cross-conversation memory, runtime skill discovery`);
}

async function main() {
  await api('/api/login', { password: config.adminPassword }); const status = await api('/api/status');
  if (!status.worker?.runtime?.authenticated) throw new Error(`Real worker/model authentication is required: ${status.workerError ?? status.worker?.runtime?.detail ?? 'start the worker and authenticate its dedicated profile'}`);
  console.log(`Observed worker UID ${status.worker.uid}: ${status.worker.root ? 'host root mode' : 'non-root mode'}`);
  if (process.argv.includes('--verify-restart') || process.argv.includes('--verify-restore')) {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Manifest;
    const memory = await api(`/api/memory?q=${encodeURIComponent(manifest.factKey)}`); assert(memory.length > 0, 'Memory did not survive restart/restore');
    const skill = await api(`/api/skills/${manifest.skillName}`); assert.equal(skill.activeVersion, manifest.activeVersion); assert(skill.versions.length >= 2);
    await retrieveAndUse(manifest, process.argv.includes('--verify-restore') ? 'restored' : 'restarted'); return;
  }
  if (status.queue?.length) throw new Error('Drain the existing queue before running acceptance checks; this script will not interrupt unrelated work');
  const id = randomUUID().replaceAll('-', '').slice(0, 12); const directory = join(config.stateDir, `artifacts/smoke-${id}`); mkdirSync(directory, { recursive: true });
  const manifest: Manifest = { id, factKey: `operatorfact${id}`, factValue: `violet-orbit-${id}`, skillName: `smoke-report-${id}`, activeVersion: 1 };
  const first = await conversation(`Live smoke machine ${id}`); const hostFile = join(directory, 'host.txt');
  const run = await submit(first.id,
    `Inspect the machine through a real shell command and check id -u. Wait two seconds in that foreground command, then write exactly "uid=<actual numeric UID>\\nsentinel=${id}\\n" to ${hostFile}. Do not modify unrelated host services. Call progress_checkpoint after the file exists. Report the actual command/output and UID.`);
  const initial = await sseUntil(0, event => event.runId === run.id && event.type === 'activity'); const cursor = initial.at(-1)!.seq;
  await pause(1000); const replay = await sseUntil(cursor, event => event.runId === run.id && event.type === 'completed'); const firstHistory = await waitForRun(run);
  assert(replay.every(event => event.seq > cursor)); assert(called(firstHistory, run.id, 'progress_checkpoint'));
  assert.equal(readFileSync(hostFile, 'utf8'), `uid=${status.worker.uid}\nsentinel=${id}\n`);
  console.log('PASS actual host file/UID and browser-stream disconnect/replay without canceling work');

  await prompt(first.id,
    `Remember this owner-provided acceptance fact through memory_write: key ${manifest.factKey}, value ${manifest.factValue}. Store content containing both exact strings, kind user_fact, source "owner live acceptance fixture", category "acceptance". Call progress_checkpoint afterward. Do not put the fact into standing owner instructions.`, ['memory_write', 'progress_checkpoint']);
  const remembered = await api(`/api/memory?q=${encodeURIComponent(manifest.factKey)}`); assert(remembered.some((entry: any) => entry.content.includes(manifest.factValue)));

  const skillPrompt = (version: number) => `Search existing skills first. ${version === 1 ? 'Create a small new useful report skill' : 'Revise the existing report skill by creating a new candidate version'} named ${manifest.skillName} through skill_create, skill_validate and skill_publish; do not write directly into skill package directories.
Use SKILL.md metadata name ${manifest.skillName} and a focused description for generating deterministic sum reports from JSON fixtures. Include concise portable usage instructions and helper scripts/report.mjs.
The helper is a Node ESM script taking input filename and output filename as arguments; read a JSON object {values:number[]}, write exactly JSON.stringify(${version === 1 ? '{total: sum(values)}' : '{total: sum(values), count: values.length}'}) plus a newline into the requested output file. Validate numeric inputs. Keep paths as parameters, not machine constants.
Declare this representative check: ${JSON.stringify({ name: 'sum fixture', command: 'node', args: ['{skill}/scripts/report.mjs', '{fixture}/input.json', '{fixture}/report.json'], fixtures: { 'input.json': JSON.stringify({ values: [2, 4, 6] }) }, expectedFiles: { 'report.json': version === 1 ? '{"total":12}\n' : '{"total":12,"count":3}\n' } })}. Ensure the check really passes, inspect its evidence, then publish and activate. Record progress_checkpoint with the published version. Preserve all earlier versions.`;
  await prompt(first.id, skillPrompt(1), ['skill_search', 'skill_create', 'skill_validate', 'skill_publish', 'progress_checkpoint']);
  const v1 = await api(`/api/skills/${manifest.skillName}`); assert.equal(v1.activeVersion, 1); assert.equal(v1.versions.find((version: any) => version.version === 1)?.evidence.passed, true);
  await retrieveAndUse(manifest, 'fresh');
  await prompt(first.id, skillPrompt(2), ['skill_create', 'skill_validate', 'skill_publish']);
  const v2 = await api(`/api/skills/${manifest.skillName}`); assert.equal(v2.activeVersion, 2); assert(v2.versions.some((version: any) => version.version === 1 && existsSync(join(version.path, 'SKILL.md'))));
  await retrieveAndUse({ ...manifest, activeVersion: 2 }, 'second-version');
  await api(`/api/skills/${manifest.skillName}/action`, { action: 'rollback', version: 1 });
  assert.equal((await api(`/api/skills/${manifest.skillName}`)).activeVersion, 1); await retrieveAndUse(manifest, 'rollback');
  console.log('PASS immutable second skill version, retained first version and exercised rollback');

  const queueConversation = await conversation(`Live smoke queue ${id}`); const interruptedFile = join(directory, 'must-not-exist.txt');
  const one = await submit(queueConversation.id, `Run one foreground shell command: sleep 30, then write the string late to ${interruptedFile}. Do not detach or background it. Keep the shell running until the wait completes.`);
  const twoFile = join(directory, 'queued.txt'); const two = await submit(queueConversation.id, `Write exactly queued-${id} to ${twoFile} through a real shell command, then finish.`);
  const commandDeadline = Date.now() + timeoutMs;
  let commandObserved = false;
  while (Date.now() < commandDeadline) {
    const history = await api(`/api/conversations/${queueConversation.id}`);
    const started = history.events.some((event: AppEvent) => event.runId === one.id && event.type === 'activity' && (event.data as any).method === 'item/started' && (event.data as any).item?.type === 'commandExecution');
    if (started) { assert.equal(history.runs.find((candidate: Run) => candidate.id === two.id).status, 'queued'); commandObserved = true; break; }
    if (terminal.has(history.runs.find((candidate: Run) => candidate.id === one.id).status)) throw new Error('First queue test run ended before interruption could reach its foreground command');
    await pause(500);
  }
  assert(commandObserved, 'Timed out before observing a foreground command to interrupt; inspect the run in the UI before retrying');
  await api(`/api/runs/${one.id}/interrupt`, {}); await waitForRun(one, 'interrupted'); const queueHistory = await waitForRun(two);
  assert.equal(readFileSync(twoFile, 'utf8'), `queued-${id}`); assert(!existsSync(interruptedFile), 'Interrupted owned command unexpectedly completed its delayed side effect');
  const firstRun = queueHistory.runs.find((candidate: Run) => candidate.id === one.id); const secondRun = queueHistory.runs.find((candidate: Run) => candidate.id === two.id);
  assert(Date.parse(secondRun.startedAt) >= Date.parse(firstRun.finishedAt), 'Two host-changing runs overlapped');
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600 });
  console.log(`PASS serialized queue and observed interruption. Acceptance manifest: ${manifestPath}`);
  console.log('Next: stop controller/worker, restart them, then run this script with --verify-restart. Export/restore into a fresh APP_STATE_DIR and run --verify-restore to exercise the remembered fact and installed helper again.');
}
main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
