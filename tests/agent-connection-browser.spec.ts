import { expect, test, type Page } from '@playwright/test';
import type { AgentConnection } from '../src/agent-connection-schema';

// Agent connection and worker-start endpoints are test doubles. Administrator login,
// conversations, queued tasks, and workspace status use the real controller.
async function modelSignInFixture(page: Page, workerConnected = true) {
  const rootWorkerCommand = 'sudo env APP_STATE_DIR=/tmp/operator-browser-fixture APP_CONTROLLER_UID=1000 /usr/bin/node --import tsx /srv/operator/src/worker.ts';
  let connection: AgentConnection = { state: 'disconnected', workerConnected, workerUid: workerConnected ? 0 : null, ...(!workerConnected ? { rootWorkerCommand } : {}) };
  let starts = 0;
  let cancellations = 0;
  let workerStarts = 0;
  let statusRequests = 0;
  let failNextStart = false;
  let failNextWorkerStart = false;
  page.on('request', request => { if (new URL(request.url()).pathname === '/api/status') statusRequests++; });
  await page.route('**/api/agent/*', async route => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/agent/connect') {
      starts++;
      connection = failNextStart ? { state: 'error', workerConnected: true, workerUid: 0, error: 'ChatGPT sign-in could not start. Please retry.' } : {
        state: 'connecting', workerConnected: true, workerUid: 0,
        verificationUrl: 'https://auth.openai.com/codex/device', userCode: `TEST-CODE${starts}`,
        expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
      };
      failNextStart = false;
    } else if (path === '/api/agent/cancel') {
      cancellations++;
      connection = { state: 'disconnected', workerConnected: true, workerUid: 0 };
    } else if (path === '/api/agent/worker') {
      workerStarts++;
      if (failNextWorkerStart) {
        failNextWorkerStart = false;
        await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'The host requires administrator permission. Run the setup command, then try again.' }) });
        return;
      }
      connection = { state: 'disconnected', workerConnected: true, workerUid: 0 };
    }
    await route.fulfill({ status: 200, contentType: 'application/json', headers: { 'cache-control': 'no-store' }, body: JSON.stringify(connection) });
  });
  return {
    get starts() { return starts; }, get cancellations() { return cancellations; },
    get workerStarts() { return workerStarts; }, get statusRequests() { return statusRequests; },
    complete() { connection = { state: 'connected', workerConnected: true, workerUid: 0 }; },
    failStart() { failNextStart = true; },
    failWorkerStart() { failNextWorkerStart = true; },
  };
}

async function login(page: Page) {
  await page.goto('/');
  await page.getByLabel('Administrator password').fill('browser-test-password-only');
  await page.getByRole('button', { name: 'Enter workspace' }).click();
  await expect(page.locator('.topbar').getByRole('button', { name: 'Connect agent' })).toBeVisible();
}

test('ChatGPT sign-in fixture survives refresh and completion refreshes the durable queue', async ({ page, context }) => {
  const fixture = await modelSignInFixture(page);
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await login(page);
  await page.getByRole('button', { name: 'New conversation' }).click();
  const prompt = 'Agent connection browser fixture: preserve this queued task.';
  await page.getByLabel('Message your operator').fill(prompt);
  await page.getByRole('button', { name: 'Send message' }).click();
  await expect(page.getByTestId('message-user')).toContainText(prompt);
  await page.getByRole('button', { name: 'Memory', exact: true }).click();
  await page.locator('.topbar').getByRole('button', { name: 'Connect agent' }).click();
  const dialog = page.getByRole('dialog', { name: 'Connect your agent' });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('UID 0 · root');
  await dialog.getByRole('button', { name: 'Continue with ChatGPT' }).click();
  await expect(dialog.getByLabel('One-time sign-in code')).toHaveText('TEST-CODE1');
  const signIn = dialog.getByRole('link', { name: 'Open ChatGPT sign-in' });
  await expect(signIn).toHaveAttribute('href', 'https://auth.openai.com/codex/device');
  await expect(signIn).toHaveAttribute('target', '_blank');
  await expect(signIn).toHaveAttribute('rel', /noopener/);
  await dialog.getByRole('button', { name: 'Copy sign-in code' }).click();
  await expect(dialog.getByRole('button', { name: 'Copy sign-in code' })).toHaveText('Copied');
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('TEST-CODE1');

  await page.reload();
  await page.locator('.topbar').getByRole('button', { name: 'Connect agent' }).click();
  await expect(page.getByRole('dialog').getByLabel('One-time sign-in code')).toHaveText('TEST-CODE1');
  expect(fixture.starts).toBe(1);
  const requestsBeforeCompletion = fixture.statusRequests;
  fixture.complete();
  await expect(page.getByRole('dialog', { name: 'Agent connected' })).toBeVisible();
  await expect.poll(() => fixture.statusRequests).toBeGreaterThan(requestsBeforeCompletion);
  await page.getByRole('button', { name: 'Back to workspace' }).click();
  await expect(page.getByRole('dialog')).not.toBeVisible();
  await expect(page.getByTestId('message-user')).toHaveCount(1);
  await expect(page.getByTestId('message-user')).toContainText(prompt);
  // This fixture does not execute model work. The real saved task remains queued.
  await expect(page.getByText('Queued', { exact: true }).first()).toBeVisible();
  expect(await page.evaluate(() => Object.values(localStorage).some(value => value.includes('TEST-CODE')))).toBe(false);
  await page.getByRole('button', { name: 'Cancel queued task' }).click();
  await expect(page.getByText('Interrupted', { exact: true }).first()).toBeVisible();
});

test('sign-in fixture supports cancellation, retry, and keyboard return to the connection button', async ({ page }) => {
  const fixture = await modelSignInFixture(page);
  await login(page);
  const trigger = page.locator('.topbar').getByRole('button', { name: 'Connect agent' });
  await trigger.click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: 'Continue with ChatGPT' }).click();
  await expect(dialog.getByLabel('One-time sign-in code')).toHaveText('TEST-CODE1');
  await dialog.getByRole('button', { name: 'Cancel sign-in' }).click();
  await expect(dialog.getByRole('button', { name: 'Continue with ChatGPT' })).toBeVisible();
  await expect(dialog.getByLabel('One-time sign-in code')).toHaveCount(0);
  expect(fixture.cancellations).toBe(1);
  fixture.failStart();
  await dialog.getByRole('button', { name: 'Continue with ChatGPT' }).click();
  await expect(dialog.getByRole('alert')).toContainText('Please retry.');
  await dialog.getByRole('button', { name: 'Retry ChatGPT sign-in' }).click();
  await expect(dialog.getByLabel('One-time sign-in code')).toHaveText('TEST-CODE3');
  await page.keyboard.press('Escape');
  await expect(dialog).not.toBeVisible();
  await expect(trigger).toBeFocused();
  await expect(trigger).toHaveAttribute('aria-expanded', 'false');
  await trigger.click();
  await expect(dialog.getByLabel('One-time sign-in code')).toHaveText('TEST-CODE3');
  expect(fixture.starts).toBe(3);
  await dialog.getByRole('button', { name: 'Cancel sign-in' }).click();
});

test('phone connection fixture requests a root worker and keeps host setup and sign-in inside the viewport', async ({ page, context }, testInfo) => {
  const fixture = await modelSignInFixture(page, false);
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page);
  await page.locator('.topbar').getByRole('button', { name: 'Connect agent' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('Worker disconnected');
  await expect(dialog).toContainText('Start the root worker');
  fixture.failWorkerStart();
  await dialog.getByRole('button', { name: 'Start root worker' }).click();
  await expect(dialog.getByRole('alert')).toContainText('administrator permission');
  await expect(dialog.getByLabel('Root worker setup command')).toContainText('sudo env APP_STATE_DIR=/tmp/operator-browser-fixture');
  await dialog.getByRole('button', { name: 'Copy root worker command' }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toContain('sudo env APP_STATE_DIR=');
  expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  await dialog.getByRole('button', { name: 'Start root worker' }).click();
  await expect(dialog).toContainText('UID 0 · root');
  expect(fixture.workerStarts).toBe(2);
  await dialog.getByRole('button', { name: 'Continue with ChatGPT' }).click();
  await expect(dialog.getByLabel('One-time sign-in code')).toHaveText('TEST-CODE1');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('agent-sign-in-phone.png'), animations: 'disabled' });
  await dialog.getByRole('button', { name: 'Cancel sign-in' }).click();
});
