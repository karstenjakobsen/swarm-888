import { defineConfig } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const stateDir = mkdtempSync(join(tmpdir(), 'vps-operator-browser-'));
const repositoryPath = join(stateDir, 'repository');
mkdirSync(repositoryPath);
writeFileSync(join(repositoryPath, 'README.md'), 'Temporary browser test repository.\n');
const gitEnv = { ...process.env };
for (const key of Object.keys(gitEnv)) if (key.startsWith('GIT_')) delete gitEnv[key];
Object.assign(gitEnv, { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0' });
const git = (args: string[]) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'commit.gpgSign=false', '-C', repositoryPath, ...args], { stdio: 'pipe', env: gitEnv });
git(['init', '--initial-branch=main']);
git(['add', 'README.md']);
git(['-c', 'user.name=Browser fixture', '-c', 'user.email=browser-fixture@example.invalid', 'commit', '-m', 'Initialize browser fixture']);
const inherited = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined && !entry[0].startsWith('APP_')));

export default defineConfig({
  testDir: './tests',
  testMatch: ['browser.spec.ts', 'agent-connection-browser.spec.ts'],
  fullyParallel: false,
  workers: 1,
  timeout: 30_000,
  reporter: 'list',
  use: { baseURL: 'http://127.0.0.1:5181', trace: 'retain-on-failure' },
  webServer: [
    {
      command: 'node --import tsx src/controller.ts',
      url: 'http://127.0.0.1:3101/api/session',
      reuseExistingServer: false,
      env: { ...inherited, APP_STATE_DIR: stateDir, APP_PROJECTS_DIR: join(stateDir, 'projects'), APP_REPOSITORY_PATH: repositoryPath, APP_ALLOW_TEMP_STATE: 'true', APP_REQUIRE_ROOT_WORKER: 'true', ADMIN_PASSWORD: 'browser-test-password-only', APP_PORT: '3101', APP_ORIGINS: 'http://127.0.0.1:5181', APP_IMPROVEMENT_ENABLED: 'false' },
    },
    {
      command: 'npm exec vite -- --host 127.0.0.1 --port 5181',
      url: 'http://127.0.0.1:5181',
      reuseExistingServer: false,
      env: { ...inherited, VITE_API_TARGET: 'http://127.0.0.1:3101' },
    },
  ],
});
