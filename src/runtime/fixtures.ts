import { spawn } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { z } from 'zod';
import { checkSkillSchema } from '../ipc.js';
import { terminateGroup } from './processes.js';

function within(root: string, path: string): string {
  if (isAbsolute(path)) throw new Error('Fixture paths must be relative');
  const absolute = resolve(root, path); const rel = relative(root, absolute);
  if (rel === '..' || rel.startsWith(`..${sep}`)) throw new Error('Fixture path leaves temporary directory');
  return absolute;
}
export async function checkSkill(stateDir: string, input: z.infer<typeof checkSkillSchema>, hooks?: { spawned: (pid: number) => void }) {
  const parent = resolve(stateDir, 'workspaces/checks'); mkdirSync(parent, { recursive: true, mode: 0o700 });
  const checks: Array<{ name: string; exitCode: number | null; stdout: string; stderr: string; passed: boolean; error?: string; durationMs: number }> = [];
  for (const check of input.checks) {
    const started = Date.now(); const fixture = mkdtempSync(resolve(parent, 'fixture-')); const skill = resolve(fixture, 'skill');
    let stdout = ''; let stderr = ''; let exitCode: number | null = null; let error: string | undefined;
    let childPid: number | undefined;
    try {
      cpSync(input.candidatePath, skill, { recursive: true, dereference: false, errorOnExist: true });
      for (const [name, content] of Object.entries(check.fixtures)) { const path = within(fixture, name); mkdirSync(resolve(path, '..'), { recursive: true }); writeFileSync(path, content); }
      const replace = (arg: string) => arg.replaceAll('{skill}', skill).replaceAll('{fixture}', fixture);
      await new Promise<void>((finish, reject) => {
        const child = spawn(process.execPath, [fileURLToPath(new URL('./check-runner.mjs', import.meta.url))], { cwd: fixture, stdio: ['pipe', 'pipe', 'pipe'], detached: true });
        childPid = child.pid;
        if (childPid) hooks?.spawned(childPid);
        // The runner blocks until PID/start/boot is committed by the hook above.
        child.stdin.write(JSON.stringify({ command: replace(check.command), args: check.args.map(replace) }) + '\n');
        child.stdin.on('error', () => {});
        const timer = setTimeout(() => { error = 'Representative check timed out'; try { process.kill(-child.pid!, 'SIGKILL'); } catch {} }, check.timeoutMs ?? 15_000);
        let overflow = false;
        const capture = (which: 'stdout' | 'stderr', data: Buffer) => {
          if (which === 'stdout') stdout += data.toString(); else stderr += data.toString();
          if (stdout.length + stderr.length > 512_000 && !overflow) { overflow = true; error = 'Representative check output exceeded 512 kB'; try { process.kill(-child.pid!, 'SIGKILL'); } catch {} }
        };
        child.stdout.on('data', data => capture('stdout', data)); child.stderr.on('data', data => capture('stderr', data));
        child.once('error', err => { clearTimeout(timer); reject(err); });
        child.once('close', code => { clearTimeout(timer); exitCode = code; finish(); });
      });
      if (exitCode !== 0) error ??= `Helper exited with code ${exitCode}`;
      if (check.expectedStdout !== undefined && stdout !== check.expectedStdout) error ??= 'stdout did not match the expected fixture result';
      for (const [path, expected] of Object.entries(check.expectedFiles ?? {})) if (readFileSync(within(fixture, path), 'utf8') !== expected) error ??= `Output ${path} did not match the expected fixture result`;
    } catch (err) { error = err instanceof Error ? err.message : String(err); }
    finally { if (childPid) await terminateGroup(childPid); rmSync(fixture, { recursive: true, force: true }); }
    checks.push({ name: check.name, exitCode, stdout: stdout.slice(0, 256_000), stderr: stderr.slice(0, 256_000), passed: !error && exitCode === 0, ...(error ? { error } : {}), durationMs: Date.now() - started });
  }
  return { passed: checks.every(check => check.passed), checks, workerUid: process.getuid?.() ?? -1, checkedAt: new Date().toISOString() };
}
