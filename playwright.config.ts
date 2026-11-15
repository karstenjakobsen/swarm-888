import { defineConfig } from '@playwright/test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const stateDir = mkdtempSync(join(tmpdir(), 'vps-operator-browser-'));
const inherited = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));

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
      command: 'npm run controller',
      url: 'http://127.0.0.1:3101/api/session',
      reuseExistingServer: false,
      env: { ...inherited, APP_STATE_DIR: stateDir, APP_ALLOW_TEMP_STATE: 'true', ADMIN_PASSWORD: 'browser-test-password-only', APP_PORT: '3101', APP_ORIGINS: 'http://127.0.0.1:5181', APP_IMPROVEMENT_ENABLED: 'false' },
    },
    {
      command: 'npm exec vite -- --host 127.0.0.1 --port 5181',
      url: 'http://127.0.0.1:5181',
      reuseExistingServer: false,
      env: { ...inherited, VITE_API_TARGET: 'http://127.0.0.1:3101' },
    },
  ],
});
