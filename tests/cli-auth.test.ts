import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { acquireLock, lockAlive } from '../src/lock.ts';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const cli = join(projectRoot, 'src/cli.ts');

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'operator-cli-auth-'));
  const stateDir = join(directory, 'state');
  const recordPath = join(directory, 'codex-invocation.json');
  const executable = join(directory, 'fixture-codex.mjs');
  mkdirSync(stateDir, { mode: 0o700 });
  mkdirSync(join(stateDir, 'worker'), { mode: 0o700 });
  writeFileSync(executable, `#!${process.execPath}
import fs from 'node:fs';
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { input += chunk; });
process.stdin.on('end', () => {
  fs.writeFileSync(process.env.AUTH_TEST_RECORD, JSON.stringify({
    args: process.argv.slice(2), codexHome: process.env.CODEX_HOME, input,
  }), { mode: 0o600 });
  if (process.argv.includes('status')) {
    console.log('Fixture profile status');
    process.exitCode = Number(process.env.AUTH_TEST_STATUS_CODE ?? 0);
  } else console.log('Fixture authentication completed');
});
`, { mode: 0o700 });
  // Supply only fixture configuration and process prerequisites. In particular,
  // no inherited API credentials, Codex profile or administrator password enter
  // the child, and the host HOME variable is never changed.
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    ...(process.env.LD_LIBRARY_PATH ? { LD_LIBRARY_PATH: process.env.LD_LIBRARY_PATH } : {}),
    LANG: 'C.UTF-8',
    APP_STATE_DIR: stateDir,
    APP_ALLOW_TEMP_STATE: 'true',
    APP_CONTROLLER_UID: String(process.getuid!()),
    APP_ORIGINS: 'http://localhost:5173',
    CODEX_BIN: executable,
    AUTH_TEST_RECORD: recordPath,
  };
  async function run(args: string[], input = '', overrides: NodeJS.ProcessEnv = {}) {
    return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
      const child = spawn(process.execPath, ['--import', 'tsx', cli, 'auth', ...args], {
        cwd: projectRoot, env: { ...env, ...overrides }, stdio: ['pipe', 'pipe', 'pipe'],
      });
      let stdout = '', stderr = '';
      const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Fixture auth CLI timed out')); }, 10_000);
      child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
      child.stdout.on('data', chunk => { stdout += chunk; });
      child.stderr.on('data', chunk => { stderr += chunk; });
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
      child.stdin.end(input);
    });
  }
  return {
    stateDir, recordPath, run,
    record: () => JSON.parse(readFileSync(recordPath, 'utf8')) as { args: string[]; codexHome: string; input: string },
    close: () => rmSync(directory, { recursive: true, force: true }),
  };
}

test('device login forwards the native flag and uses only the application Codex profile', async () => {
  const f = fixture();
  try {
    const result = await f.run(['--device-auth']);
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(f.record(), { args: ['login', '--device-auth'], codexHome: join(f.stateDir, 'runtime'), input: '' });
    assert.equal(existsSync(join(f.stateDir, 'worker/lock.json')), false);
  } finally { f.close(); }
});

test('default API-key login forwards the fixture key through stdin without putting it in argv or output', async () => {
  const f = fixture(), key = 'fixture-only-api-key-123456789';
  try {
    const result = await f.run([], key);
    assert.equal(result.code, 0, result.stderr);
    const invocation = f.record();
    assert.deepEqual(invocation.args, ['login', '--with-api-key']);
    assert.equal(invocation.codexHome, join(f.stateDir, 'runtime'));
    assert.equal(invocation.input, key);
    assert(!JSON.stringify(invocation.args).includes(key));
    assert(!(result.stdout + result.stderr).includes(key));
    assert.equal(existsSync(join(f.stateDir, 'worker/lock.json')), false);
  } finally { f.close(); }
});

test('a live worker blocks mutating logins but permits read-only status without disturbing its lock', async () => {
  const f = fixture(), lock = join(f.stateDir, 'worker/lock.json'), release = acquireLock(lock);
  try {
    for (const args of [[], ['--device-auth']]) {
      const denied = await f.run(args, 'fixture-only-api-key');
      assert.equal(denied.code, 1);
      assert.match(denied.stderr, /Stop the worker with Ctrl\+C before authenticating/);
      assert.equal(existsSync(f.recordPath), false, 'No Codex process may start for a blocked mutating login');
      assert.equal(lockAlive(lock), true);
    }
    const status = await f.run(['status']);
    assert.equal(status.code, 0, status.stderr);
    assert.deepEqual(f.record(), { args: ['login', 'status'], codexHome: join(f.stateDir, 'runtime'), input: '' });
    assert.match(status.stdout, /Fixture profile status/);
    assert.equal(lockAlive(lock), true);
    const unauthenticated = await f.run(['status'], '', { AUTH_TEST_STATUS_CODE: '1' });
    assert.equal(unauthenticated.code, 1, 'Read-only status must preserve the native authentication status exit code');
    assert(!unauthenticated.stderr.includes('Codex authentication failed'));
    assert.equal(lockAlive(lock), true);
  } finally { release(); f.close(); }
});
