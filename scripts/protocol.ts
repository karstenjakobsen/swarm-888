/** Regenerate the transitive protocol types imported by our adapter from the pinned executable. */
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, normalize, resolve } from 'node:path';

const project = resolve(import.meta.dirname, '..');
const executable = resolve(project, 'node_modules/.bin/codex');
const version = spawnSync(executable, ['--version'], { encoding: 'utf8' });
if (version.error || version.status !== 0 || version.stdout.trim() !== 'codex-cli 0.166.0') throw new Error('Install the pinned Codex 0.166.0 with npm ci before generating protocol types');
const temporary = mkdtempSync(join(tmpdir(), 'operator-schema-'));
const target = resolve(project, 'src/runtime/generated');
const roots = ['InitializeParams.ts', 'v2/ThreadStartParams.ts', 'v2/ThreadResumeParams.ts', 'v2/TurnStartParams.ts', 'v2/ThreadStartResponse.ts', 'v2/ThreadResumeResponse.ts', 'v2/TurnStartResponse.ts', 'v2/GetAccountResponse.ts', 'v2/LoginAccountParams.ts', 'v2/LoginAccountResponse.ts', 'v2/CancelLoginAccountParams.ts', 'v2/CancelLoginAccountResponse.ts', 'v2/AccountLoginCompletedNotification.ts', 'v2/SkillsListResponse.ts', 'v2/ToolRequestUserInputParams.ts', 'v2/ToolRequestUserInputResponse.ts', 'v2/McpServerElicitationRequestParams.ts', 'v2/McpServerElicitationRequestResponse.ts'];
try {
  const generated = spawnSync(executable, ['app-server', 'generate-ts', '--out', temporary], { stdio: 'inherit' });
  if (generated.error || generated.status !== 0) throw new Error('Codex schema generation failed');
  rmSync(target, { recursive: true, force: true });
  const visited = new Set<string>();
  function copy(relative: string): void {
    if (visited.has(relative)) return; visited.add(relative);
    const source = join(temporary, relative); const destination = join(target, relative); mkdirSync(dirname(destination), { recursive: true }); copyFileSync(source, destination);
    for (const match of readFileSync(source, 'utf8').matchAll(/from "([^"]+)"/g)) copy(normalize(join(dirname(relative), match[1] + '.ts')));
  }
  roots.forEach(copy); console.log(`Generated ${visited.size} protocol files from Codex 0.166.0`);
} finally { rmSync(temporary, { recursive: true, force: true }); }
