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

// Managed source/deployment and connector endpoints below are HTTP fixtures.
// They exercise the UI contract without starting host services or model work.
test('managed source saves a commit before deployment and distinguishes the running revision on a phone', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const id = '27c0f87b-a744-4ffc-bfa5-12950b49345b';
  const connectorId = 'f207c528-e775-4aa0-a939-d8776b487660';
  const source = { repositoryPath: '/tmp/browser-repository', branch: 'operator/generated', path: `generated/projects/${id}`, workspacePath: `/tmp/browser-workspace/generated/projects/${id}`, commit: 'a'.repeat(40), dirty: false };
  const project = { id, name: 'Managed service fixture', description: 'Fixture source and release', origin: 'created', directory: `/srv/projects/${id}`, createdAt: '2026-11-15T10:00:00Z', updatedAt: '2026-11-15T10:00:00Z', status: 'running', lastCheckedAt: null, conversationIds: [], runs: [], components: [], connectorIds: [] as string[], source, deployment: { commit: 'b'.repeat(40), unitName: 'fixture-managed.service', releaseDirectory: '/srv/projects/releases/previous', status: 'running', detail: 'Fixture service is running.', checkedAt: new Date().toISOString() } };
  const connector = { id: connectorId, name: 'Fixture echo', description: 'Echo test tool', transport: 'stdio', command: 'node', args: ['server.mjs'], enabled: true, tools: [{ name: 'echo', inputSchema: { type: 'object' } }], status: 'connected', detail: 'Fixture', checkedAt: null };
  let files: Record<string, string> = { 'operator-package.json': JSON.stringify({ schemaVersion: 1, id, kind: 'project', name: project.name }), 'server.mjs': 'export const message = "before";\n' };
  let saves = 0, deployments = 0;
  const state = { worker: { uid: 0, root: true, pid: 42, activeRunId: null, runtime: { available: true, authenticated: true, version: 'fixture', detail: 'HTTP fixture only' } }, workerError: null, maintenance: false, queue: [] };
  await page.route('**/api/status', route => route.fulfill({ json: state }));
  await page.route('**/api/events?*', route => route.fulfill({ contentType: 'text/event-stream', body: `event: status\ndata: ${JSON.stringify(state)}\n\n` }));
  await page.route('**/api/projects', route => route.fulfill({ json: [project] }));
  await page.route('**/api/connectors', route => route.fulfill({ json: [connector] }));
  await page.route(`**/api/projects/${id}/source`, route => {
    if (route.request().method() === 'PUT') {
      const body = route.request().postDataJSON();
      expect(body.message).toBe('Change fixture response');
      expect(Object.keys(body.files)).toEqual(['server.mjs']);
      files = { ...files, ...body.files }; source.commit = 'c'.repeat(40); saves++;
    }
    return route.fulfill({ json: { source, manifest: { schemaVersion: 1, id, kind: 'project', name: project.name, description: project.description, run: { command: 'node', args: ['server.mjs'] } }, files } });
  });
  await page.route(`**/api/projects/${id}/deploy`, route => {
    expect(route.request().postDataJSON()).toEqual({});
    project.deployment = { ...project.deployment, commit: source.commit, status: 'running', detail: 'Fixture release updated.' };
    deployments++;
    return route.fulfill({ json: project.deployment });
  });
  await page.route(`**/api/projects/${id}/deployment`, route => route.fulfill({ json: project.deployment }));
  await page.route(`**/api/projects/${id}/deployment/logs`, route => route.fulfill({ json: { text: 'Fixture release is listening.\n', truncated: false, checkedAt: '2026-11-15T10:00:00Z' } }));
  await page.route(`**/api/projects/${id}/deployment/stop`, route => { project.deployment.status = 'stopped'; project.deployment.detail = 'Fixture service stopped.'; return route.fulfill({ json: project.deployment }); });
  await page.route(`**/api/projects/${id}/connectors`, route => { project.connectorIds = route.request().postDataJSON().connectorIds; return route.fulfill({ json: project }); });
  await login(page);
  await page.getByRole('button', { name: 'Open navigation' }).click();
  await page.getByRole('button', { name: 'Projects', exact: true }).click();
  const workspace = page.getByRole('region', { name: 'Source and deployment' });
  await expect(workspace).toContainText('aaaaaaaaaa');
  await expect(workspace).toContainText('bbbbbbbbbb');
  await workspace.getByLabel('Source file', { exact: true }).selectOption('server.mjs');
  await expect(workspace.getByLabel('Source code')).toHaveValue('export const message = "before";\n');
  await workspace.getByLabel('Source code').fill('export const message = "after";\n');
  await expect(workspace.getByRole('button', { name: 'Deploy committed source' })).toBeDisabled();
  await workspace.getByLabel('Commit message').fill('Change fixture response');
  await workspace.getByRole('button', { name: 'Save & commit', exact: true }).click();
  await expect(workspace.getByRole('status')).toContainText('Source saved and committed.');
  expect(saves).toBe(1);
  await workspace.evaluate(element => element.scrollIntoView({ block: 'start' }));
  await page.screenshot({ path: testInfo.outputPath('managed-source-editor-phone.png'), animations: 'disabled' });
  await expect(workspace.locator('.commit-comparison>div').first()).toContainText('cccccccccc');
  await expect(workspace.locator('.commit-comparison>div').last()).toContainText('bbbbbbbbbb');
  await workspace.getByRole('button', { name: 'Deploy committed source' }).click();
  await expect(workspace.locator('.commit-comparison>div').last()).toContainText('cccccccccc');
  expect(deployments).toBe(1);
  await workspace.getByLabel('Commit message').fill('Keep this future commit message');
  await workspace.getByRole('button', { name: 'Refresh deployment', exact: true }).click();
  await expect(workspace.getByRole('status')).toContainText('Deployment status refreshed.');
  await expect(workspace.getByLabel('Commit message')).toHaveValue('Keep this future commit message');
  await workspace.getByRole('button', { name: 'Deployment logs', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Deployment logs', exact: true })).toContainText('Fixture release is listening.');
  await workspace.getByRole('button', { name: 'Stop service', exact: true }).click();
  await expect(workspace).toContainText('Release stopped');
  await expect(workspace.getByRole('button', { name: 'Stop service', exact: true })).toBeDisabled();
  const assignments = page.getByRole('region', { name: 'Project connections' });
  await assignments.getByRole('checkbox', { name: 'Fixture echo' }).check();
  await assignments.getByRole('button', { name: 'Save connections' }).click();
  await expect(assignments.getByRole('button', { name: 'Connections saved' })).toBeVisible();
  expect(project.connectorIds).toEqual([connectorId]);
  project.deployment.checkedAt = new Date(Date.now() - 61_000).toISOString();
  await workspace.getByRole('button', { name: 'Refresh deployment', exact: true }).click();
  await expect(workspace).toContainText('Release status unknown');
  await expect(workspace.locator('.commit-comparison>div').last()).toContainText('Last observed: stopped');
  await expect(workspace.locator('.commit-comparison>div').last()).toContainText('cccccccccc');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('managed-source-phone.png'), fullPage: true, animations: 'disabled' });
});

test('Connections creates a local demo, discovers tools, validates JSON, and shows a tool result', async ({ page }, testInfo) => {
  const id = '9d995377-c583-485e-aedf-48b2abbc2cd4';
  const connector = { id, name: 'Local echo fixture', description: 'HTTP fixture for the local demo flow', transport: 'stdio', command: 'node', args: ['server.mjs'], enabled: true, tools: [] as { name: string; description: string; inputSchema: unknown }[], status: 'untested', detail: 'Test to discover tools.', checkedAt: null as string | null };
  let registered = false, calls = 0;
  await page.route('**/api/connectors', route => route.fulfill({ json: registered ? [connector] : [] }));
  await page.route('**/api/connectors/examples', route => { registered = true; return route.fulfill({ json: connector }); });
  await page.route(`**/api/connectors/${id}/test`, route => {
    connector.status = 'connected'; connector.detail = 'Discovered 1 MCP tool.'; connector.checkedAt = '2026-11-15T10:00:00Z';
    connector.tools = [{ name: 'echo', description: 'Echo a text value', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } }];
    return route.fulfill({ json: connector });
  });
  await page.route(`**/api/connectors/${id}/call`, route => {
    const body = route.request().postDataJSON(); expect(body).toEqual({ name: 'echo', arguments: { text: 'Hello from the fixture' } }); calls++;
    return route.fulfill({ json: { content: [{ type: 'text', text: body.arguments.text }] } });
  });
  await page.route(`**/api/connectors/${id}`, route => { connector.enabled = route.request().postDataJSON().enabled; return route.fulfill({ json: connector }); });
  await login(page);
  await page.getByRole('button', { name: 'Connections', exact: true }).click();
  await page.locator('.management-heading-actions').getByRole('button', { name: 'Create local demo' }).click();
  await expect(page.getByRole('heading', { name: connector.name, exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Test connection', exact: true }).click();
  await expect(page.getByLabel('Tool to test', { exact: true })).toHaveValue('echo');
  await expect(page.locator('.project-detail-heading .connection-status')).toHaveText('Test passed');
  await page.getByLabel('Tool arguments (JSON)', { exact: true }).fill('[');
  await page.getByRole('button', { name: 'Run tool', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Enter valid JSON');
  expect(calls).toBe(0);
  await page.getByLabel('Tool arguments (JSON)', { exact: true }).fill('{"text":"Hello from the fixture"}');
  await page.getByRole('button', { name: 'Run tool', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Tool result' })).toContainText('Hello from the fixture');
  expect(calls).toBe(1);
  await page.getByRole('button', { name: 'Disable connection', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Run tool', exact: true })).toBeDisabled();
  await expect(page.locator('.connection-detail')).toContainText('Disabled.');
  await page.getByRole('button', { name: 'Enable connection', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Run tool', exact: true })).toBeEnabled();
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('connections-phone.png'), fullPage: true, animations: 'disabled' });
  await page.locator('.connection-tools').evaluate(element => element.scrollIntoView({ block: 'start' }));
  await page.screenshot({ path: testInfo.outputPath('connection-tools-phone.png'), animations: 'disabled' });
});

test('Connections registers an HTTP server without credential fields', async ({ page }) => {
  let submitted: unknown;
  const connector = { id: 'f15f39d3-3a57-426f-bbf0-e7acf9105d4f', name: 'Fixture HTTP tools', description: '', enabled: true, transport: 'http', url: 'http://127.0.0.1:4400/mcp', projectId: null, tools: [], status: 'untested', detail: 'Not tested.', checkedAt: null };
  await page.route('**/api/connectors', route => { if (route.request().method() === 'POST') { submitted = route.request().postDataJSON(); return route.fulfill({ json: connector }); } return route.fulfill({ json: [] }); });
  await page.route('**/api/projects', route => route.fulfill({ json: [] }));
  await login(page);
  await page.getByRole('button', { name: 'Connections', exact: true }).click();
  await page.locator('.management-heading-actions').getByRole('button', { name: 'Add connection', exact: true }).click();
  const editor = page.locator('.connection-editor');
  await editor.getByLabel('Connection name').fill(connector.name);
  await editor.getByLabel('Transport', { exact: true }).selectOption('http');
  await expect(editor.getByLabel('Command', { exact: true })).toHaveCount(0);
  await expect(editor).toContainText('Credentials are not supported here yet.');
  await editor.getByLabel('MCP server URL').fill(connector.url);
  await editor.getByRole('button', { name: 'Add connection', exact: true }).click();
  await expect(page.getByRole('heading', { name: connector.name, exact: true })).toBeVisible();
  expect(submitted).toEqual({ name: connector.name, description: '', transport: 'http', projectId: null, enabled: true, url: connector.url });
});

async function sourceReviewFixture(page: Page) {
  const id = '944396de-488a-4412-9ad7-ac98f9abe875';
  const source = { repositoryPath: '/tmp/review-repository', branch: 'operator/generated', path: `generated/projects/${id}`, workspacePath: `/tmp/review-workspace/${id}`, commit: '1'.repeat(40), dirty: false };
  const manifest = { schemaVersion: 1, id, kind: 'project', name: 'Source review fixture', description: '', run: { command: 'node', args: ['server.mjs'] } };
  const files: Record<string, string> = { 'server.mjs': 'export const value = "original";\n', 'operator-package.json': JSON.stringify(manifest) };
  const project = { id, name: manifest.name, description: '', origin: 'created', directory: `/tmp/review-projects/${id}`, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), status: 'ready', lastCheckedAt: null, conversationIds: [], runs: [], components: [], connectorIds: [] as string[], source };
  const connectors = ['First tool server', 'Second tool server'].map((name, index) => ({ id: index === 0 ? '682956bc-6131-4627-85da-dbf6200fa73b' : '22a62e37-e40f-4b4d-a217-bd20ca749c29', name, description: '', transport: 'stdio', command: 'node', args: ['server.mjs'], enabled: true, tools: [{ name: 'echo', inputSchema: { type: 'object' } }], status: 'connected', detail: 'Test passed.', checkedAt: new Date().toISOString() }));
  const projects = [project];
  const state = { worker: { uid: 0, root: true, pid: 42, activeRunId: null, runtime: { available: true, authenticated: true, version: 'fixture', detail: 'HTTP review fixture only' } }, workerError: null, maintenance: false, queue: [] };
  await page.route('**/api/status', route => route.fulfill({ json: state }));
  await page.route('**/api/events?*', route => route.fulfill({ contentType: 'text/event-stream', body: `event: status\ndata: ${JSON.stringify(state)}\n\n` }));
  await page.route('**/api/projects', route => route.fulfill({ json: projects }));
  await page.route('**/api/connectors', route => route.fulfill({ json: connectors }));
  await page.route(`**/api/projects/${id}/source`, route => route.fulfill({ json: { source, manifest, files } }));
  return { project, projects, source, files, manifest, connectors };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

test('source requests lock the editor and navigation preserves an unsaved draft', async ({ page }) => {
  const fixture = await sourceReviewFixture(page);
  const write = deferred(), read = deferred(), navigation = deferred();
  let writeStarted = false, readStarted = false, navigationStarted = false;
  await page.route(`**/api/projects/${fixture.project.id}/source`, async route => {
    if (route.request().method() !== 'PUT') return route.fallback();
    const body = route.request().postDataJSON();
    expect(body.expectedCommit).toBe('1'.repeat(40));
    writeStarted = true; await write.promise;
    Object.assign(fixture.files, body.files); fixture.source.commit = '2'.repeat(40);
    return route.fulfill({ json: { source: fixture.source, manifest: fixture.manifest, files: fixture.files } });
  });
  try {
    await login(page);
    await page.getByRole('button', { name: 'Projects', exact: true }).click();
    const workspace = page.getByRole('region', { name: 'Source and deployment' });
    await workspace.getByLabel('Source file', { exact: true }).selectOption('server.mjs');
    await workspace.getByLabel('Source code').fill('export const value = "my draft";\n');
    page.once('dialog', dialog => dialog.dismiss());
    await page.getByRole('button', { name: 'Memory', exact: true }).click();
    await expect(workspace.getByLabel('Source code')).toHaveValue('export const value = "my draft";\n');
    await expect(page.getByRole('heading', { name: 'Source review fixture', exact: true })).toBeVisible();
    await workspace.getByRole('button', { name: 'Save & commit', exact: true }).click();
    await expect.poll(() => writeStarted).toBe(true);
    await expect(workspace.getByLabel('Source code')).toBeDisabled();
    await expect(workspace.getByLabel('New source file path')).toBeDisabled();
    await expect(workspace.getByLabel('Commit message')).toBeDisabled();
    write.resolve();
    await expect(workspace.getByRole('status')).toContainText('Source saved and committed.');
    await expect(workspace.getByLabel('Source code')).toBeEnabled();
    await expect(workspace.getByLabel('Source code')).toHaveValue('export const value = "my draft";\n');
    await page.route(`**/api/projects/${fixture.project.id}/source`, async route => {
      readStarted = true; await read.promise;
      fixture.files['server.mjs'] = 'export const value = "refreshed";\n';
      return route.fulfill({ json: { source: fixture.source, manifest: fixture.manifest, files: fixture.files } });
    });
    await workspace.getByRole('button', { name: 'Refresh files', exact: true }).click();
    await expect.poll(() => readStarted).toBe(true);
    await expect(workspace.getByLabel('Source code')).toBeDisabled();
    await expect(workspace.getByRole('button', { name: 'Add file', exact: true })).toBeDisabled();
    read.resolve();
    await expect(workspace.getByLabel('Source code')).toHaveValue('export const value = "refreshed";\n');
    await workspace.getByLabel('Source code').fill('export const value = "draft after refresh";\n');
    await page.route('**/api/conversations', async route => {
      if (route.request().method() !== 'POST') return route.fallback();
      navigationStarted = true; await navigation.promise;
      return route.fulfill({ status: 503, json: { error: 'Fixture navigation failed' } });
    });
    page.once('dialog', dialog => dialog.accept());
    await page.locator('.new-conversation').click();
    await expect.poll(() => navigationStarted).toBe(true);
    await expect(workspace.getByLabel('Source code')).toBeDisabled();
    navigation.resolve();
    await expect(workspace.getByLabel('Source code')).toBeEnabled();
    page.once('dialog', dialog => dialog.dismiss());
    await page.getByRole('button', { name: 'Memory', exact: true }).click();
    await expect(workspace.getByLabel('Source code')).toHaveValue('export const value = "draft after refresh";\n');
  } finally { write.resolve(); read.resolve(); navigation.resolve(); }
});

test('a rejected stale source save keeps the draft until refresh is explicitly confirmed', async ({ page }) => {
  await page.clock.install();
  const fixture = await sourceReviewFixture(page);
  await page.route(`**/api/projects/${fixture.project.id}/source`, route => {
    if (route.request().method() !== 'PUT') return route.fallback();
    expect(route.request().postDataJSON().expectedCommit).toBe('1'.repeat(40));
    fixture.source.commit = '3'.repeat(40); fixture.files['server.mjs'] = 'export const value = "remote change";\n';
    return route.fulfill({ status: 409, json: { error: 'Source changed since this editor loaded. Refresh files before saving.' } });
  });
  await login(page);
  await page.getByRole('button', { name: 'Projects', exact: true }).click();
  const workspace = page.getByRole('region', { name: 'Source and deployment' });
  await workspace.getByLabel('Source file', { exact: true }).selectOption('server.mjs');
  await workspace.getByLabel('Source code').fill('export const value = "keep this draft";\n');
  await workspace.getByRole('button', { name: 'Save & commit', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Source changed since this editor loaded.');
  await expect(workspace.getByLabel('Source code')).toHaveValue('export const value = "keep this draft";\n');
  await page.clock.fastForward(15_100);
  await expect(workspace.locator('.management-warning')).toContainText('Source changed elsewhere.');
  await expect(workspace.getByRole('button', { name: 'Save & commit', exact: true })).toBeDisabled();
  page.once('dialog', dialog => dialog.dismiss());
  await workspace.getByRole('button', { name: 'Refresh files', exact: true }).click();
  await expect(workspace.getByLabel('Source code')).toHaveValue('export const value = "keep this draft";\n');
  page.once('dialog', dialog => dialog.accept());
  await workspace.getByRole('button', { name: 'Refresh files', exact: true }).click();
  await expect(workspace.getByLabel('Source code')).toHaveValue('export const value = "remote change";\n');
  await expect(workspace.locator('.commit-comparison>div').first()).toContainText('3333333333');
});

test('project assignments synchronize clean state, preserve local choices, and lock during save', async ({ page }) => {
  await page.clock.install();
  const fixture = await sourceReviewFixture(page);
  const save = deferred(); let saving = false;
  await page.route(`**/api/projects/${fixture.project.id}/connectors`, async route => {
    const selected = route.request().postDataJSON().connectorIds;
    saving = true; await save.promise; fixture.project.connectorIds = selected;
    return route.fulfill({ json: fixture.project });
  });
  try {
    await login(page);
    await page.getByRole('button', { name: 'Projects', exact: true }).click();
    const assignments = page.getByRole('region', { name: 'Project connections' });
    const first = assignments.getByRole('checkbox', { name: 'First tool server' });
    const second = assignments.getByRole('checkbox', { name: 'Second tool server' });
    await expect(first).not.toBeChecked();
    fixture.project.connectorIds = [fixture.connectors[0]!.id];
    await page.clock.fastForward(15_100);
    await expect(first).toBeChecked();
    await first.uncheck();
    fixture.project.connectorIds = fixture.connectors.map(connector => connector.id);
    await page.clock.fastForward(15_100);
    await expect(first).not.toBeChecked();
    await expect(second).not.toBeChecked();
    await expect(assignments.getByRole('status')).toContainText('Saved connections changed elsewhere.');
    await second.check();
    await assignments.getByRole('button', { name: 'Save connections' }).click();
    await expect.poll(() => saving).toBe(true);
    await expect(first).toBeDisabled(); await expect(second).toBeDisabled();
    save.resolve();
    await expect(assignments.getByRole('button', { name: 'Connections saved' })).toBeVisible();
    await expect(first).not.toBeChecked(); await expect(second).toBeChecked();
    expect(fixture.project.connectorIds).toEqual([fixture.connectors[1]!.id]);
  } finally { save.resolve(); }
});

test('a late connection test updates its record without closing a new registration draft', async ({ page }) => {
  const fixture = await sourceReviewFixture(page);
  const connector = { ...fixture.connectors[0]!, status: 'untested', tools: [] as unknown[] };
  const pending = deferred(); let started = false;
  await page.route('**/api/connectors', route => route.fulfill({ json: [connector] }));
  await page.route(`**/api/connectors/${connector.id}/test`, async route => {
    started = true; await pending.promise;
    return route.fulfill({ json: { ...connector, status: 'connected', tools: fixture.connectors[0]!.tools } });
  });
  try {
    await login(page);
    await page.getByRole('button', { name: 'Connections', exact: true }).click();
    await page.getByRole('button', { name: 'Test connection', exact: true }).click();
    await expect.poll(() => started).toBe(true);
    await page.locator('.management-heading-actions').getByRole('button', { name: 'Add connection', exact: true }).click();
    await page.getByLabel('Connection name').fill('Keep my registration draft');
    pending.resolve();
    await expect(page.getByLabel('Connection name')).toHaveValue('Keep my registration draft');
    await expect(page.locator('.connections-panel .project-list-item .connection-status')).toHaveText('Test passed');
    await page.locator('.connection-editor').getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(page.getByLabel('Tool to test', { exact: true })).toHaveValue('echo');
  } finally { pending.resolve(); }
});

test('late tool results do not replace changed arguments or a reselected connection context', async ({ page }) => {
  const fixture = await sourceReviewFixture(page);
  const first = fixture.connectors[0]!;
  const pending = deferred(), reselected = deferred(); let calls = 0;
  await page.route(`**/api/connectors/${first.id}/call`, async route => {
    calls++;
    if (calls === 1) await pending.promise;
    if (calls === 3) await reselected.promise;
    return route.fulfill({ json: { isError: calls === 4, content: [{ type: 'text', text: calls === 4 ? 'Tool failure fixture' : calls === 2 ? 'Fresh result' : 'Stale result' }] } });
  });
  try {
    await login(page);
    await page.getByRole('button', { name: 'Connections', exact: true }).click();
    await page.getByLabel('Tool arguments (JSON)', { exact: true }).fill('{"text":"first request"}');
    await page.getByRole('button', { name: 'Run tool', exact: true }).click();
    await expect.poll(() => calls).toBe(1);
    await page.getByLabel('Tool arguments (JSON)', { exact: true }).fill('{"text":"next request"}');
    pending.resolve();
    await expect(page.getByRole('button', { name: 'Run tool', exact: true })).toBeEnabled();
    await expect(page.getByRole('region', { name: 'Tool result' })).toHaveCount(0);
    await expect(page.getByLabel('Tool arguments (JSON)', { exact: true })).toHaveValue('{"text":"next request"}');
    await page.getByRole('button', { name: 'Run tool', exact: true }).click();
    await expect(page.getByRole('region', { name: 'Tool result' })).toContainText('Fresh result');
    await page.getByRole('button', { name: 'Run tool', exact: true }).click();
    await expect.poll(() => calls).toBe(3);
    await page.locator('.connections-panel .project-list-item').filter({ hasText: 'Second tool server' }).click();
    await page.locator('.connections-panel .project-list-item').filter({ hasText: 'First tool server' }).click();
    reselected.resolve();
    await expect(page.getByRole('button', { name: 'Run tool', exact: true })).toBeEnabled();
    await expect(page.getByRole('region', { name: 'Tool result' })).toHaveCount(0);
    await page.getByRole('button', { name: 'Run tool', exact: true }).click();
    await expect(page.locator('.tool-output.is-error')).toContainText('Tool failure fixture');
    await expect(page.getByRole('heading', { name: 'Tool reported an error' })).toBeVisible();
  } finally { pending.resolve(); reselected.resolve(); }
});

async function runtimeRecoveryFixture(page: Page, operations: { id: string; method: string; status: 'running' | 'uncertain'; requiresExternalInspection: boolean }[], legacyIds: string[] = []) {
  const conversation = { id: 'runtime_recovery_conversation', title: 'Runtime recovery fixture', threadId: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  const queued = { id: 'runtime_recovery_queued', conversationId: conversation.id, prompt: 'Keep this task queued until runtime recovery completes.', status: 'queued', kind: 'user', summary: '', createdAt: new Date().toISOString(), startedAt: null, finishedAt: null, error: null, requestId: 'runtime_recovery_request', parentRunId: null };
  const state = {
    worker: { uid: 0, root: true, pid: 42, activeRunId: null, uncertainRuns: [...operations.filter(operation => operation.status === 'uncertain').map(operation => operation.id), ...legacyIds], runtimeOperations: operations, runtime: { available: true, authenticated: true, version: 'fixture', detail: 'HTTP runtime recovery fixture only' } },
    workerError: null, maintenance: false, queue: [queued],
  };
  await page.route('**/api/status', route => route.fulfill({ json: state }));
  await page.route('**/api/events?*', route => route.fulfill({ contentType: 'text/event-stream', body: `event: status\ndata: ${JSON.stringify(state)}\n\n` }));
  await page.route('**/api/conversations', route => route.fulfill({ json: [conversation] }));
  await page.route(`**/api/conversations/${conversation.id}`, route => route.fulfill({ json: { conversation, messages: [], runs: [queued], events: [] } }));
  return { state, queued };
}

test('uncertain external runtime operations keep work paused until explicit inspection acknowledgement', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const id = 'runtime_e874ddcb-a1b6-4129-aa01-89f2bb8091b7';
  const fixture = await runtimeRecoveryFixture(page, [{ id, method: 'connectors/call', status: 'uncertain', requiresExternalInspection: true }]);
  const resolve = deferred(); let resolutions = 0;
  await page.route(`**/api/runs/${id}/resolve`, async route => {
    expect(route.request().postDataJSON()).toEqual({ acknowledgeExternalEffects: true });
    resolutions++; await resolve.promise;
    fixture.state.worker.uncertainRuns = []; fixture.state.worker.runtimeOperations = [];
    return route.fulfill({ json: { resolved: true } });
  });
  try {
    await login(page);
    const recovery = page.getByRole('region', { name: 'Execution recovery' });
    await expect(recovery).toContainText('connectors/call');
    await expect(recovery).toContainText('Uncertain');
    await expect(recovery).toContainText('The action may already have happened.');
    await expect(recovery).toContainText('Reconciliation will not retry it or stop an intended independent service.');
    await expect(page.getByRole('status').filter({ hasText: 'Queue paused: execution needs reconciliation' })).toBeVisible();
    await expect(page.getByText('Queued', { exact: true }).first()).toBeVisible();
    expect(fixture.queued.startedAt).toBeNull();
    const button = recovery.getByRole('button', { name: `Reconcile operation ${id}`, exact: true });
    const acknowledgement = recovery.getByRole('checkbox', { name: 'I inspected the external effects', exact: true });
    await expect(button).toBeDisabled();
    expect(resolutions).toBe(0);
    await acknowledgement.check(); await expect(button).toBeEnabled();
    await acknowledgement.uncheck(); await expect(button).toBeDisabled();
    await acknowledgement.check();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath('runtime-recovery-phone.png'), animations: 'disabled' });
    await button.click();
    await expect.poll(() => resolutions).toBe(1);
    await expect(button).toBeDisabled(); await expect(acknowledgement).toBeDisabled();
    resolve.resolve();
    await expect(recovery).toHaveCount(0);
    await expect(page.getByRole('status').filter({ hasText: 'Queue paused: execution needs reconciliation' })).toHaveCount(0);
    expect(resolutions).toBe(1);
    expect(fixture.queued.startedAt).toBeNull(); // This fixture never executes model work.
  } finally { resolve.resolve(); }
});

test('local runtime and legacy orphan reconciliation keep empty request bodies', async ({ page }) => {
  const id = 'runtime_495dd2fa-5304-4ded-82bd-d90f46a2e45f', legacy = 'fixture_legacy_recovery';
  const fixture = await runtimeRecoveryFixture(page, [{ id, method: 'managed/prepare', status: 'uncertain', requiresExternalInspection: false }], [legacy]);
  const resolved: string[] = [];
  await page.route('**/api/runs/*/resolve', route => {
    const path = new URL(route.request().url()).pathname;
    const operationId = path.split('/').at(-2)!;
    expect(route.request().postDataJSON()).toEqual({});
    resolved.push(operationId);
    fixture.state.worker.uncertainRuns = fixture.state.worker.uncertainRuns.filter(value => value !== operationId);
    fixture.state.worker.runtimeOperations = fixture.state.worker.runtimeOperations.filter(operation => operation.id !== operationId);
    return route.fulfill({ json: { resolved: true } });
  });
  await login(page);
  const recovery = page.getByRole('region', { name: 'Execution recovery' });
  await expect(recovery).toContainText('managed/prepare');
  await expect(recovery.getByRole('checkbox')).toHaveCount(0);
  await recovery.getByRole('button', { name: `Reconcile operation ${id}`, exact: true }).click();
  await expect(recovery).not.toContainText('managed/prepare');
  await recovery.getByRole('button', { name: `Host inspected, resolve orphan ${legacy}`, exact: true }).click();
  await expect(recovery).toHaveCount(0);
  expect(resolved).toEqual([id, legacy]);
});

test('running runtime operations show queue waiting without offering reconciliation', async ({ page }) => {
  await runtimeRecoveryFixture(page, [{ id: 'runtime_1b1ffdc4-95bf-4546-aa9e-11f26196c283', method: 'managed/deploy', status: 'running', requiresExternalInspection: true }]);
  await login(page);
  const notice = page.getByRole('status').filter({ hasText: 'Runtime operation in progress' });
  await expect(notice).toContainText('managed/deploy');
  await expect(notice).toContainText('Running');
  await expect(page.getByRole('status').filter({ hasText: 'Queue waiting for runtime operation' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Execution recovery' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /Reconcile operation/ })).toHaveCount(0);
});
