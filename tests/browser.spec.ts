import { expect, test, type Page } from '@playwright/test';

async function login(page: Page) {
  await page.goto('/');
  await page.getByLabel('Administrator password').fill('browser-test-password-only');
  await page.getByRole('button', { name: 'Enter workspace' }).click();
  await expect(page.locator('.new-conversation')).toBeVisible();
}

async function nextPaint(page: Page) {
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
}

test('authenticated workspace persists queued work, memory revisions, and owner instructions', async ({ page, context }, testInfo) => {
  const pageErrors: string[] = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Welcome back.' })).toBeVisible();
  await page.getByLabel('Administrator password').fill('invalid-browser-password');
  await page.getByRole('button', { name: 'Enter workspace' }).click();
  await expect(page.getByRole('alert')).toContainText('Invalid administrator credential');
  await page.getByLabel('Administrator password').fill('browser-test-password-only');
  await page.getByRole('button', { name: 'Enter workspace' }).click();
  await expect(page.locator('.new-conversation')).toBeVisible();
  const sessionCookie = (await context.cookies()).find(cookie => cookie.name === 'operator_session');
  expect(sessionCookie?.httpOnly).toBe(true);
  expect(sessionCookie?.sameSite).toBe('Strict');
  await expect(page.getByText('Worker disconnected', { exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('workspace-desktop.png'), fullPage: true, animations: 'disabled' });
  await page.locator('.new-conversation').click();
  await page.getByLabel('Message your operator').fill('Browser smoke task: preserve this queued goal.');
  await page.getByRole('button', { name: 'Send message' }).click();
  await expect(page.getByTestId('message-user')).toHaveCount(1);
  await expect(page.getByTestId('message-user')).toContainText('Browser smoke task');
  await page.reload();
  await expect(page.getByTestId('message-user')).toHaveCount(1);
  await expect(page.getByTestId('message-user')).toContainText('Browser smoke task');
  await expect(page.getByText('Queued', { exact: true }).first()).toBeVisible();
  await expect(page.getByRole('status').filter({ hasText: 'Queue paused: worker disconnected' })).toContainText('Your queued tasks are saved.');
  await expect(page.getByRole('status').filter({ hasText: 'Queue paused: worker disconnected' }).getByRole('button', { name: 'Connect agent' })).toBeVisible();
  await expect(page.locator('.queue-panel > summary > strong')).toHaveText(/\d+ tasks? queued/);

  await page.getByRole('button', { name: 'Memory', exact: true }).click();
  await page.getByRole('button', { name: 'Add memory' }).click();
  await page.getByLabel('Content', { exact: true }).fill('Browser smoke fact: the observatory is green.');
  await page.getByLabel('Tags', { exact: true }).fill('browser, fixture');
  await page.getByRole('button', { name: 'Save memory' }).click();
  await expect(page.getByRole('heading', { name: 'Browser smoke fact: the observatory is green.' })).toBeVisible();
  await page.getByRole('button', { name: 'Edit memory' }).click();
  await page.getByLabel('Content', { exact: true }).fill('Browser smoke fact: the observatory is moss green.');
  await page.getByRole('button', { name: 'Save memory' }).click();
  await expect(page.getByRole('heading', { name: 'Browser smoke fact: the observatory is moss green.' })).toBeVisible();
  await page.getByLabel('Search memory').fill('observatory');
  await expect(page.locator('.resource-row')).toHaveCount(1);
  await page.locator('.resource-row').click();
  await expect(page.getByText('Revision 1', { exact: true })).toBeVisible();
  await expect(page.getByText('Revision 2', { exact: true })).toBeVisible();
  await page.locator('.instructions-card > summary').click();
  await page.getByLabel('Standing owner instructions', { exact: true }).fill('Use concise progress checkpoints. Browser fixture.');
  await page.getByRole('button', { name: 'Save instructions' }).click();
  await expect(page.getByRole('button', { name: 'Saved', exact: true })).toBeVisible();
  await page.reload();
  await page.getByRole('button', { name: 'Memory', exact: true }).click();
  await page.locator('.instructions-card > summary').click();
  await expect(page.getByLabel('Standing owner instructions', { exact: true })).toHaveValue('Use concise progress checkpoints. Browser fixture.');

  await page.getByRole('button', { name: 'Skills', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Skills', exact: true })).toBeVisible();
  await expect(page.locator('.skill-row').first()).toBeVisible();
  await page.locator('.skill-row').first().click();
  await expect(page.getByRole('heading', { name: 'Validation evidence', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Artifacts', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Your work, collected' })).toBeVisible();
  expect(pageErrors).toEqual([]);
});

test('phone navigation and composer fit the viewport', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await page.getByLabel('Administrator password').fill('browser-test-password-only');
  await page.getByRole('button', { name: 'Enter workspace' }).click();
  await expect(page.getByRole('button', { name: 'Open navigation' })).toBeVisible();
  await page.getByRole('button', { name: 'Open navigation' }).click();
  await page.locator('.new-conversation').click();
  await expect(page.getByLabel('Message your operator')).toBeVisible();
  await expect(page.locator('.sidebar')).not.toHaveClass(/is-open/);
  await page.screenshot({ path: testInfo.outputPath('workspace-phone.png'), fullPage: true, animations: 'disabled' });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.getByRole('button', { name: 'Open navigation' }).click();
  await page.getByRole('button', { name: 'Memory', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Memory', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Add memory' }).click();
  await expect(page.getByLabel('Content', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test('selecting a memory hides the previous record until the new detail arrives', async ({ page }) => {
  const first = { id: 'memory_first', content: 'First memory detail', kind: 'user_fact', source: 'fixture', revision: 1, tags: [], updatedAt: '2026-11-15T10:00:00Z' };
  const second = { ...first, id: 'memory_second', content: 'Second memory detail' };
  let secondRequested = false;
  let releaseSecond!: () => void;
  const secondReady = new Promise<void>(resolve => { releaseSecond = resolve; });
  await page.route('**/api/memory?*', route => route.fulfill({ json: [first, second] }));
  await page.route('**/api/memory/memory_first', route => route.fulfill({ json: first }));
  await page.route('**/api/memory/memory_second', async route => {
    secondRequested = true;
    await secondReady;
    await route.fulfill({ json: second });
  });
  try {
    await login(page);
    await page.getByRole('button', { name: 'Memory', exact: true }).click();
    await page.locator('.resource-row').filter({ hasText: first.content }).click();
    await expect(page.getByRole('heading', { name: first.content })).toBeVisible();
    await page.locator('.resource-row').filter({ hasText: second.content }).click();
    await expect.poll(() => secondRequested).toBe(true);
    await expect(page.getByRole('heading', { name: first.content })).not.toBeVisible();
    await expect(page.getByRole('button', { name: 'Edit memory' })).not.toBeVisible();
    releaseSecond();
    await expect(page.getByRole('heading', { name: second.content })).toBeVisible();
  } finally { releaseSecond(); }
});

test('memory search keeps the latest query when an earlier response arrives last', async ({ page }) => {
  const entry = (id: string) => ({ id, content: `${id} search result`, kind: 'user_fact', revision: 1, tags: [] });
  let firstRequested = false;
  let releaseFirst!: () => void;
  const firstReady = new Promise<void>(resolve => { releaseFirst = resolve; });
  await page.route('**/api/memory?*', async route => {
    const query = new URL(route.request().url()).searchParams.get('q');
    if (query === 'earlier') { firstRequested = true; await firstReady; }
    await route.fulfill({ json: query ? [entry(query)] : [] });
  });
  try {
    await login(page);
    await page.getByRole('button', { name: 'Memory', exact: true }).click();
    await page.getByLabel('Search memory').fill('earlier');
    await expect.poll(() => firstRequested).toBe(true);
    await page.getByLabel('Search memory').fill('latest');
    await expect(page.locator('.resource-row')).toContainText('latest search result');
    const response = page.waitForResponse(value => new URL(value.url()).searchParams.get('q') === 'earlier');
    releaseFirst();
    await (await response).finished();
    await nextPaint(page);
    await expect(page.locator('.resource-row')).toHaveCount(1);
    await expect(page.locator('.resource-row')).toContainText('latest search result');
  } finally { releaseFirst(); }
});

test('skill selection ignores stale detail and actions use the displayed skill version', async ({ page }) => {
  const skill = (name: string, version: number) => ({ name, description: `${name} fixture`, state: 'disabled', activeVersion: version, versions: [{ version, state: 'validated', body: `${name} instructions`, files: [] }] });
  const first = skill('earlier-skill', 1), latest = skill('latest-skill', 2);
  let firstRequested = false;
  let releaseFirst!: () => void;
  const firstReady = new Promise<void>(resolve => { releaseFirst = resolve; });
  const actions: Array<{ path: string; body: unknown }> = [];
  await page.route('**/api/skills', route => route.fulfill({ json: [first, latest].map(value => ({ ...value, versions: 1 })) }));
  await page.route('**/api/skills/earlier-skill', async route => { firstRequested = true; await firstReady; await route.fulfill({ json: first }); });
  await page.route('**/api/skills/latest-skill', route => route.fulfill({ json: latest }));
  await page.route('**/api/skills/*/action', route => {
    actions.push({ path: new URL(route.request().url()).pathname, body: route.request().postDataJSON() });
    return route.fulfill({ json: {} });
  });
  try {
    await login(page);
    await page.getByRole('button', { name: 'Skills', exact: true }).click();
    await page.locator('.skill-row').filter({ hasText: first.name }).click();
    await expect.poll(() => firstRequested).toBe(true);
    await page.locator('.skill-row').filter({ hasText: latest.name }).click();
    await expect(page.getByRole('heading', { name: latest.name, exact: true })).toBeVisible();
    const response = page.waitForResponse(value => new URL(value.url()).pathname === '/api/skills/earlier-skill');
    releaseFirst();
    await (await response).finished();
    await nextPaint(page);
    await expect(page.getByRole('heading', { name: latest.name, exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Enable', exact: true }).click();
    await expect.poll(() => actions).toEqual([{ path: '/api/skills/latest-skill/action', body: { action: 'activate', version: '2' } }]);
  } finally { releaseFirst(); }
});

test('sending a task preserves a new draft typed while its response is pending', async ({ page }) => {
  let submitted = false;
  let release!: () => void;
  const ready = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/conversations/*/runs', async route => {
    const response = await route.fetch();
    submitted = true;
    await ready;
    await route.fulfill({ response });
  });
  try {
    await login(page);
    await page.locator('.new-conversation').click();
    const composer = page.getByLabel('Message your operator');
    await composer.fill('First submitted browser fixture task');
    await page.getByRole('button', { name: 'Send message' }).click();
    await expect.poll(() => submitted).toBe(true);
    await composer.fill('Keep this next draft');
    release();
    await expect(page.getByRole('button', { name: 'Send message' })).toBeEnabled();
    await expect(composer).toHaveValue('Keep this next draft');
  } finally { release(); }
});

test('Projects registers durable website context and opens a linked operator conversation', async ({ page }) => {
  await login(page);
  await page.getByRole('button', { name: 'Projects', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Projects', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Create project', exact: true }).click();
  const projectEditor = page.locator('.project-editor');
  await projectEditor.getByLabel('Project name', { exact: true }).fill('Browser project website');
  await projectEditor.getByLabel('Description', { exact: true }).fill('Keep the website and its operating context together.');
  await projectEditor.getByRole('button', { name: 'Create project', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Browser project website', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Add component', exact: true }).click();
  const componentEditor = page.locator('.project-component-editor');
  await componentEditor.getByLabel('Component name', { exact: true }).fill('Public website');
  await componentEditor.getByLabel('Website URL', { exact: true }).fill('https://example.com/');
  await componentEditor.getByRole('button', { name: 'Add component', exact: true }).click();
  const website = page.locator('.project-component').filter({ hasText: 'Public website' });
  await expect(website).toBeVisible();
  await expect(website.locator('.project-status')).toHaveText('Unknown');
  await expect(website.getByRole('link', { name: 'Open website' })).toHaveAttribute('href', 'https://example.com/');
  await expect(website.getByRole('link', { name: 'Open website' })).toHaveAttribute('rel', /noopener/);
  await page.getByRole('button', { name: 'Add component', exact: true }).click();
  await componentEditor.getByLabel('Component name', { exact: true }).fill('Daily cron report');
  await componentEditor.getByLabel('Type', { exact: true }).selectOption('scheduled_job');
  await componentEditor.getByLabel('Scheduler', { exact: true }).selectOption('cron');
  await expect(componentEditor.getByLabel('Timer unit', { exact: true })).toHaveCount(0);
  await componentEditor.getByLabel('Script path', { exact: true }).fill('scripts/report.mjs');
  await componentEditor.getByLabel('Cron expression', { exact: true }).fill('0 2 * * *');
  await componentEditor.getByLabel('Timezone', { exact: true }).fill('Europe/Paris');
  await componentEditor.getByRole('button', { name: 'Add component', exact: true }).click();
  const cron = page.locator('.project-component').filter({ hasText: 'Daily cron report' });
  await expect(cron).toContainText('Cron job');
  await expect(cron).toContainText('0 2 * * * · Europe/Paris');
  await expect(cron).toContainText('scripts/report.mjs');
  await expect(cron).toContainText('Unavailable from cron');
  await cron.getByRole('button', { name: 'Edit Daily cron report' }).click();
  await expect(componentEditor.getByLabel('Scheduler', { exact: true })).toHaveValue('cron');
  await expect(componentEditor.getByLabel('Cron expression', { exact: true })).toHaveValue('0 2 * * *');
  await componentEditor.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.reload();
  await page.getByRole('button', { name: 'Projects', exact: true }).click();
  await page.locator('.project-list-item').filter({ hasText: 'Browser project website' }).click();
  await expect(page.locator('.project-component').getByRole('heading', { name: 'Public website' })).toBeVisible();
  await expect(page.locator('.project-component').filter({ hasText: 'Daily cron report' })).toContainText('0 2 * * * · Europe/Paris');
  const response = page.waitForResponse(value => value.request().method() === 'POST' && /\/api\/projects\/[^/]+\/conversations$/.test(new URL(value.url()).pathname));
  await page.getByRole('button', { name: 'Ask operator', exact: true }).click();
  const conversation = await (await response).json();
  await expect(page.getByLabel('Message your operator')).toBeVisible();
  const projects = await (await page.request.get('/api/projects')).json();
  expect(projects.find((project: { name: string }) => project.name === 'Browser project website').conversationIds).toContain(conversation.id);
});

test('project observations show schedules and logs, then become unknown when the worker disconnects on a phone', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  let workerConnected = true;
  const worker = { connected: true, uid: 0, root: true, pid: 12345, runtime: { available: true, authenticated: true, version: 'fixture', detail: 'Observed fixture, no live service' }, activeRunId: null, uncertainRuns: [] };
  const state = () => ({ worker: workerConnected ? worker : null, workerError: workerConnected ? null : 'Fixture disconnected', maintenance: false, queue: [] });
  const project = {
    id: '7c13606f-9ccc-4e74-bf39-0c5b131aa012', name: 'Nightly reports', description: 'Scheduled project fixture', origin: 'created', directory: '/srv/projects/nightly-reports', createdAt: '2026-11-15T10:00:00Z', updatedAt: '2026-11-15T10:00:00Z', status: 'scheduled', lastCheckedAt: '2026-11-15T10:00:00Z', conversationIds: [], runs: [],
    components: [{ id: '9fcaa3c9-4acf-4a3d-ad03-886f16df26e2', projectId: '7c13606f-9ccc-4e74-bf39-0c5b131aa012', name: 'Daily report', kind: 'scheduled_job', unitName: 'nightly-reports.timer', url: null, scriptPath: null, schedule: 'Daily at 02:00', timezone: 'Europe/Paris', status: 'scheduled', stale: false, createdAt: '2026-11-15T10:00:00Z', updatedAt: '2026-11-15T10:00:00Z', observation: { status: 'scheduled', serviceState: 'active', detail: 'Timer enabled; previous execution succeeded.', checkedAt: '2026-11-15T10:00:00Z', lastRunAt: '2026-11-15T01:00:00Z', nextRunAt: '2026-11-16T01:00:00Z', lastExitCode: 0 } }],
  };
  await page.route('**/api/status', route => route.fulfill({ json: state() }));
  await page.route('**/api/events?*', route => route.fulfill({ contentType: 'text/event-stream', body: `event: status\ndata: ${JSON.stringify(state())}\n\n` }));
  await page.route('**/api/projects', route => route.fulfill({ json: [project] }));
  await page.route('**/api/projects/*/components/*/logs', route => route.fulfill({ json: { text: 'Report completed successfully.\n', truncated: false, checkedAt: '2026-11-15T10:00:00Z' } }));
  await login(page);
  await page.getByRole('button', { name: 'Open navigation' }).click();
  await page.getByRole('button', { name: 'Projects', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Nightly reports', exact: true })).toBeVisible();
  const component = page.locator('.project-component');
  await expect(component.locator('.project-status')).toHaveText('Scheduled');
  await expect(component).toContainText('Daily at 02:00 · Europe/Paris');
  await expect(component).toContainText('Exit 0');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await component.getByRole('button', { name: 'View logs' }).click();
  await expect(page.getByRole('region', { name: 'Logs for Daily report' })).toContainText('Report completed successfully.');
  workerConnected = false;
  await expect(page.getByRole('status').filter({ hasText: 'Live status is unknown' })).toBeVisible({ timeout: 8000 });
  await expect(component.locator('.project-status')).toHaveText('Unknown');
  await expect(component).toContainText('Last observation:');
  await expect(component.getByRole('button', { name: 'View logs' })).toBeDisabled();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('projects-phone.png'), fullPage: true, animations: 'disabled' });
});
