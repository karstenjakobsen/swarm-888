/** Credential-required acceptance checks against an already running real controller and worker.
 * This script never supplies a fake runtime, changes login profiles, or launches a root controller.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from '../src/config.ts';
import type { AppEvent, Run } from '../src/shared.ts';
import type { Project } from '../src/projects/schemas.ts';

const config = loadConfig({ requireAdmin: true });
const base = process.env.APP_SMOKE_URL ?? `http://127.0.0.1:${config.port}`;
const origin = config.origins[0]!;
const timeoutMs = Number(process.env.APP_SMOKE_TIMEOUT_MS ?? 600_000);
const terminal = new Set(['completed', 'failed', 'interrupted', 'uncertain']);
let cookie = ''; let csrf = '';
const pause = (ms: number) => new Promise(resolveWait => setTimeout(resolveWait, ms));
async function api(path: string, body?: unknown, method = body === undefined ? 'GET' : 'POST'): Promise<any> {
  const response = await fetch(base + path, { method, headers: { origin, cookie, ...(body === undefined ? {} : { 'content-type': 'application/json', 'x-csrf-token': csrf }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30_000) });
  const value: any = await response.json(); if (!response.ok) throw Object.assign(new Error(`${method} ${path}: ${value.error ?? response.status}`), { statusCode: response.status });
  if (path === '/api/login') { cookie = response.headers.get('set-cookie')!.split(';')[0]!; csrf = value.csrfToken; }
  return value;
}
async function conversation(manifest: Manifest) {
  assert(manifest.projectId, 'Acceptance project must be registered before creating a conversation');
  return api(`/api/projects/${manifest.projectId}/conversations`, {});
}
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
type Manifest = { id: string; factKey: string; factValue: string; skillName: string; activeVersion: number; projectId?: string; directory?: string };
const manifestPath = join(config.stateDir, 'artifacts/live-smoke-manifest.json');

async function ensureProject(manifest: Manifest): Promise<Manifest> {
  let project: Project | undefined;
  if (manifest.projectId) {
    try { project = await api(`/api/projects/${manifest.projectId}`); }
    catch (error) { if ((error as { statusCode?: number }).statusCode !== 404) throw error; }
  }
  if (!project) project = await api('/api/projects', { name: `Live smoke ${manifest.id}`, description: 'Explicit model-backed acceptance fixture. No unrelated host services are changed.' });
  return { ...manifest, projectId: project!.id, directory: project!.directory };
}

async function publishedText(history: any, runId: string, filename: string): Promise<string> {
  const publications = history.events.filter((event: AppEvent) => event.runId === runId && event.type === 'tool' && (event.data as any).name === 'artifact_publish');
  const result = publications.map((event: AppEvent) => (event.data as any).result).findLast((value: any) => typeof value?.path === 'string' && value.path.endsWith(`-${filename}`));
  assert(result && /^[a-zA-Z0-9._-]+$/.test(result.path), `Run ${runId} did not publish the expected artifact ${filename}`);
  const path = `/api/artifacts/${encodeURIComponent(result.path)}`;
  assert.equal(result.url, path, 'Published artifact must use the authenticated controller download route');
  const response = await fetch(base + path, { headers: { cookie, origin }, signal: AbortSignal.timeout(30_000) });
  assert.equal(response.status, 200, `Published artifact ${filename} could not be downloaded`);
  return response.text();
}

async function retrieveAndUse(manifest: Manifest, suffix: string) {
  assert(manifest.directory, 'Acceptance project directory is missing');
  const c = await conversation(manifest);
  const filename = `smoke-${manifest.id}-${suffix}.json`;
  const output = join(manifest.directory, filename), input = join(manifest.directory, `smoke-${manifest.id}-${suffix}-input.json`);
  const { run, history } = await prompt(c.id,
    `This is a fresh conversation in the acceptance project. Retrieve the acceptance fact identified by ${manifest.factKey} using memory_search and memory_get. Do not guess or infer its value. Create the fixture input ${input} containing exactly ${JSON.stringify({ values: [3, 5, 9] })} through a real host tool. Then explicitly use $${manifest.skillName}: discover/read its installed SKILL.md and execute its report helper against ${input}, writing ${output}. Use the installed skill, not a replacement script. Publish that output with artifact_publish using path ${output} and filename ${filename}. Record an honest skill_outcome with the observed result. Finish by stating the retrieved fact. Never write into operator source or controller state.`,
    ['memory_search', 'memory_get', 'skill_outcome', 'artifact_publish']);
  assert(history.messages.some((message: any) => message.runId === run.id && message.role === 'assistant' && message.content.includes(manifest.factValue)), 'Fresh conversation did not return the remembered unique fact');
  assert.deepEqual(JSON.parse(await publishedText(history, run.id, filename)), manifest.activeVersion === 1 ? { total: 17 } : { total: 17, count: 3 });
  const discovered = history.events.find((event: AppEvent) => event.runId === run.id && event.type === 'skills');
  assert((discovered?.data as any)?.loaded.some((skill: any) => skill.name === manifest.skillName && Number(skill.version) === manifest.activeVersion), 'Runtime did not discover the expected installed version');
  const commands = history.events.filter((event: AppEvent) => event.runId === run.id && event.type === 'activity').map((event: AppEvent) => JSON.stringify(event.data)).join('\n');
  assert(commands.includes('scripts/report.mjs'), 'Execution records do not show use of the installed helper');
  console.log(`PASS ${suffix}: independently downloaded report output, cross-conversation memory, runtime skill discovery`);
}

async function main() {
  await api('/api/login', { password: config.adminPassword }); const status = await api('/api/status');
  if (!status.worker?.runtime?.authenticated) throw new Error(`Real worker/model authentication is required: ${status.workerError ?? status.worker?.runtime?.detail ?? 'start the worker and authenticate its dedicated profile'}`);
  if (status.worker.sourceProtected !== true || !Number.isInteger(status.worker.executionUid) || status.worker.executionUid <= 0) throw new Error('Verified operator source protection and a dedicated non-root execution UID are required before live acceptance can create projects or runs.');
  const executionUid = status.worker.executionUid;
  console.log(`Observed protected agent execution UID ${executionUid}; worker broker UID ${status.worker.uid}.`);
  if (process.argv.includes('--verify-restart') || process.argv.includes('--verify-restore')) {
    const manifest = await ensureProject(JSON.parse(readFileSync(manifestPath, 'utf8')) as Manifest);
    const memory = await api(`/api/memory?q=${encodeURIComponent(manifest.factKey)}`); assert(memory.length > 0, 'Memory did not survive restart/restore');
    const skill = await api(`/api/skills/${manifest.skillName}`); assert.equal(skill.activeVersion, manifest.activeVersion); assert(skill.versions.length >= 2);
    await retrieveAndUse(manifest, process.argv.includes('--verify-restore') ? 'restored' : 'restarted');
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600 }); return;
  }
  if (status.queue?.length) throw new Error('Drain the existing queue before running acceptance checks; this script will not interrupt unrelated work');
  const id = randomUUID().replaceAll('-', '').slice(0, 12);
  const manifest = await ensureProject({ id, factKey: `operatorfact${id}`, factValue: `violet-orbit-${id}`, skillName: `smoke-report-${id}`, activeVersion: 1 });
  const directory = manifest.directory!;
  const first = await conversation(manifest), hostFilename = `smoke-${id}-host.txt`, hostFile = join(directory, hostFilename);
  const run = await submit(first.id,
    `Inspect the machine through a real shell command and check id -u. Wait two seconds in that foreground command, then write exactly "uid=<actual numeric UID>\\nsentinel=${id}\\n" to ${hostFile}. Do not modify unrelated host services or operator files. Call progress_checkpoint after the file exists. Publish it through artifact_publish using path ${hostFile} and filename ${hostFilename}. Report the actual command/output and agent execution UID.`);
  const initial = await sseUntil(0, event => event.runId === run.id && event.type === 'activity'); const cursor = initial.at(-1)!.seq;
  await pause(1000); const replay = await sseUntil(cursor, event => event.runId === run.id && event.type === 'completed'); const firstHistory = await waitForRun(run);
  assert(replay.every(event => event.seq > cursor)); assert(called(firstHistory, run.id, 'progress_checkpoint'));
  assert(called(firstHistory, run.id, 'artifact_publish'));
  assert.equal(await publishedText(firstHistory, run.id, hostFilename), `uid=${executionUid}\nsentinel=${id}\n`);
  console.log('PASS independently published host output with dedicated execution UID and browser-stream disconnect/replay without canceling work');

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

  const queueConversation = await conversation(manifest); const interruptedFile = join(directory, 'must-not-exist.txt');
  const one = await submit(queueConversation.id, `Run one foreground shell command: sleep 30, then write the string late to ${interruptedFile}. Do not detach or background it. Keep the shell running until the wait completes.`);
  const queueFilename = `smoke-${id}-queue-proof.json`, twoFile = join(directory, queueFilename);
  const two = await submit(queueConversation.id, `Wait 32 seconds in a foreground shell command so the interrupted task's original delayed write would have had time to occur. Then use a real host tool to inspect whether ${interruptedFile} exists. Do not remove or alter that file. Write JSON {"queued":"queued-${id}","interruptedFileExists":<actual observed boolean>} to ${twoFile}. Publish that JSON with artifact_publish using path ${twoFile} and filename ${queueFilename}, then finish.`);
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
  const interruptedAt = Date.now();
  await api(`/api/runs/${one.id}/interrupt`, {}); await waitForRun(one, 'interrupted'); const queueHistory = await waitForRun(two);
  assert(called(queueHistory, two.id, 'artifact_publish'));
  const queueProof = JSON.parse(await publishedText(queueHistory, two.id, queueFilename));
  assert.deepEqual(queueProof, { queued: `queued-${id}`, interruptedFileExists: false }, 'Independent published filesystem check found an interrupted delayed side effect');
  assert(Date.now() - interruptedAt >= 30_000, 'The delayed-side-effect check completed before the original command delay elapsed');
  const firstRun = queueHistory.runs.find((candidate: Run) => candidate.id === one.id); const secondRun = queueHistory.runs.find((candidate: Run) => candidate.id === two.id);
  assert(Date.parse(secondRun.startedAt) >= Date.parse(firstRun.finishedAt), 'Two host-changing runs overlapped');
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600 });
  console.log(`PASS serialized queue and observed interruption. Acceptance manifest: ${manifestPath}`);
  console.log('Next: stop controller/worker, restart them, then run this script with --verify-restart. Use --verify-restore only after a separately verified backup/restore covering controller state, the protected execution profile, and project files; the legacy snapshot command does not support that layout.');
}
main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
