import { expect, test, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';

async function login(page: Page) {
  await page.goto('/');
  await page.getByLabel('Administrator password').fill('browser-test-password-only');
  await page.getByRole('button', { name: 'Enter workspace' }).click();
  await expect(page.locator('.new-conversation')).toBeVisible();
}

async function nextPaint(page: Page) {
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
}

test('runtime errors show retry status until execution resumes or the task finishes', async ({ page }) => {
  const now = new Date().toISOString();
  const conversation = { id: 'runtime_retry_conversation', title: 'Runtime retry fixture', threadId: null, createdAt: now, updatedAt: now };
  const run: any = { id: 'runtime_retry_run', conversationId: conversation.id, prompt: 'Inspect the fixture.', status: 'running', kind: 'user', summary: '', createdAt: now, startedAt: now, finishedAt: null, error: null, requestId: 'runtime_retry_request', parentRunId: null };
  const event = (seq: number, type: string, data: Record<string, unknown>) => ({ seq, type, data, runId: run.id, conversationId: conversation.id, createdAt: now });
  const events = [
    event(1, 'activity', { method: 'error', willRetry: true, error: { message: 'Reconnecting… 2/5' } }),
    event(2, 'activity', { method: 'thread/tokenUsage/updated' }),
  ];
  const state = { worker: null, workerError: null, maintenance: false, queue: [run] };
  await page.route('**/api/status', route => route.fulfill({ json: state }));
  await page.route('**/api/events?*', route => route.fulfill({ contentType: 'text/event-stream', body: `event: status\ndata: ${JSON.stringify(state)}\n\n` }));
  await page.route('**/api/conversations', route => route.fulfill({ json: [conversation] }));
  await page.route(`**/api/conversations/${conversation.id}`, route => route.fulfill({ json: { conversation, messages: [], runs: [run], events } }));
  await login(page);
  await expect(page.getByTestId('runtime-notice')).toHaveText('Runtime retry: Reconnecting… 2/5');
  await expect(page.locator('.run-status-row')).toContainText('Working');

  events.push(event(3, 'delta', { itemId: 'response', text: 'Execution resumed.' }));
  await page.reload();
  await expect(page.getByTestId('message-assistant')).toContainText('Execution resumed.');
  await expect(page.getByTestId('runtime-notice')).toHaveCount(0);

  events.push(event(4, 'activity', { method: 'error', willRetry: false, error: { message: 'The runtime could not continue.' } }));
  await page.reload();
  await expect(page.getByTestId('runtime-notice')).toHaveText('Runtime error: The runtime could not continue.');
  run.status = 'failed'; run.error = 'The runtime could not continue.';
  await page.reload();
  await expect(page.locator('.run-status-row')).toContainText('Failed');
  await expect(page.getByTestId('runtime-notice')).toHaveCount(0);
  await expect(page.locator('.run-block .inline-error')).toContainText('The runtime could not continue.');
});

async function browserRepository(page: Page) {
  const session = await (await page.request.get('/api/session')).json();
  const response = await page.request.post('/api/repositories', { headers: { 'x-csrf-token': session.csrfToken, origin: new URL(page.url()).origin }, data: { name: `Browser repository ${randomUUID().slice(0, 8)}`, remoteUrl: `https://example.invalid/local-${randomUUID()}.git`, mode: 'create' } });
  expect(response.ok(), await response.text()).toBe(true);
  return response.json();
}

test('Repositories creates three package kinds in one local checkout and reimports exact revisions', async ({ page }, testInfo) => {
  const suffix = randomUUID().slice(0, 8), name = `Package repository ${suffix}`;
  const pageErrors: string[] = [];
  page.on('pageerror', cause => pageErrors.push(cause.message));
  await login(page);
  await page.getByRole('button', { name: 'Repositories', exact: true }).click();
  await page.getByRole('button', { name: 'Add repository', exact: true }).click();
  await page.getByLabel('Repository name', { exact: true }).fill(name);
  await expect(page.getByRole('button', { name: 'Register repository', exact: true })).toBeDisabled();
  await page.getByLabel('Remote URL', { exact: true }).fill(`https://example.invalid/operator-${suffix}.git`);
  await page.getByRole('button', { name: 'Register repository', exact: true }).click();
  await expect(page.getByRole('heading', { name, exact: true })).toBeVisible();
  await expect(page.getByText('Commits are saved locally. Remote pushes are disabled.')).toBeVisible();
  for (const kind of ['project', 'connector', 'skill']) {
    await page.getByRole('button', { name: 'Create package', exact: true }).click();
    const editor = page.locator('.repository-package-editor');
    await editor.getByLabel('Package kind', { exact: true }).selectOption(kind);
    await editor.getByLabel('Package name', { exact: true }).fill(`browser-${kind}-${suffix}`);
    await editor.getByLabel('Folder in repository', { exact: true }).fill(`${kind}s/${suffix}`);
    await editor.getByLabel('Package version', { exact: true }).fill('1.2.3');
    await editor.getByRole('button', { name: 'Create package', exact: true }).click();
    await expect(page.locator('.repository-package').filter({ hasText: `browser-${kind}-${suffix}` })).toContainText('v1.2.3');
  }
  await expect(page.locator('.repository-package')).toHaveCount(3);
  await page.getByRole('button', { name: 'Discover packages', exact: true }).click();
  const discovery = page.getByRole('region', { name: 'Discovered packages' });
  await expect(discovery.locator('.package-candidate')).toHaveCount(3);
  await expect(discovery.getByRole('checkbox')).toHaveCount(3);
  await discovery.getByRole('button', { name: 'Import selected (3)', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Selected packages imported.' })).toBeVisible();
  await page.getByRole('button', { name: 'Discover packages', exact: true }).click();
  await discovery.getByRole('button', { name: 'Import selected (3)', exact: true }).click();
  await expect(page.locator('.repository-package')).toHaveCount(3);
  const project = page.locator('.repository-package').filter({ hasText: `browser-project-${suffix}` });
  await project.getByRole('button', { name: 'Import history', exact: true }).click();
  await expect(project.getByLabel('Package import history')).toContainText('1.2.3');
  await expect(project.getByLabel('Package import history')).toContainText('Schema 1');
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('repository-packages-phone.png'), fullPage: true, animations: 'disabled' });
  expect(pageErrors).toEqual([]);
});

test('Repository import preview isolates invalid manifests and preserves last imported package after a failed update', async ({ page }) => {
  const id = randomUUID(), packageId = randomUUID(), commit = 'a'.repeat(40);
  const repository = { id, name: 'Review packages', remoteUrl: 'https://example.invalid/review.git', directory: '/tmp/review', branch: 'operator/work', sourceBranch: 'release/stable', status: 'ready' };
  const manifest = { schemaVersion: 1, id: packageId, kind: 'project', name: 'Known project', version: '1.0.0' };
  const item = { id: packageId, repositoryId: id, path: 'apps/known', kind: 'project', name: manifest.name, version: manifest.version, manifest, lastImportedCommit: commit, lastImportedAt: '2026-11-18T10:00:00Z' };
  let submitted: unknown, importCalls = 0, remoteFetches = 0;
  await page.route('**/api/repositories', route => route.fulfill({ json: [repository] }));
  await page.route('**/api/packages', route => route.fulfill({ json: [item] }));
  await page.route(`**/api/repositories/${id}/discover`, route => {
    if (route.request().method() === 'POST') {
      remoteFetches++;
      expect(route.request().postDataJSON()).toEqual({ refresh: true, branch: 'feature/review' });
      expect(route.request().headers()['x-csrf-token']).toBeTruthy();
    }
    return route.fulfill({ json: { repository, commit, ...(route.request().method() === 'POST' ? { remoteBranch: 'feature/review' } : {}), packages: [{ path: item.path, manifest, imported: true }, { path: 'apps/broken', error: 'schemaVersion must be 1' }], errors: [] } });
  });
  await page.route(`**/api/repositories/${id}/import`, route => { submitted = route.request().postDataJSON(); importCalls++; return route.fulfill({ json: importCalls === 1 ? { packages: [], imports: [{ id: 'failed-current', packageId, path: item.path, status: 'failed', packageVersion: '2.0.0', schemaVersion: 1, commit, error: 'Duplicate canonical package ID in another repository.' }] } : { packages: [item], imports: [], registrations: [{ packageId, notice: 'Source imported; runtime registration needs attention: worker unavailable.' }] } }); });
  await page.route(`**/api/repositories/${id}/imports`, route => route.fulfill({ json: [{ id: 'failed', packageId, path: item.path, status: 'failed', packageVersion: '2.0.0', schemaVersion: 1, commit: 'b'.repeat(40), error: 'Duplicate canonical package ID in another repository.', createdAt: '2026-11-18T11:00:00Z' }, { id: 'success', packageId, path: item.path, status: 'imported', packageVersion: '1.0.0', schemaVersion: 1, commit, createdAt: item.lastImportedAt }] }));
  await login(page);
  await page.getByRole('button', { name: 'Repositories', exact: true }).click();
  await page.getByRole('button', { name: 'Discover packages', exact: true }).click();
  await expect(page.getByLabel('Import apps/broken', { exact: true })).toBeDisabled();
  expect(remoteFetches).toBe(0);
  await expect(page.getByLabel('Remote branch to fetch', { exact: true })).toHaveValue('release/stable');
  await page.getByLabel('Remote branch to fetch', { exact: true }).fill('feature/review');
  await page.getByRole('button', { name: 'Fetch & preview remote' }).click();
  await expect(page.getByLabel('Import apps/broken', { exact: true })).toBeDisabled();
  await expect(page.getByLabel('Discovered packages')).toContainText('feature/review');
  expect(remoteFetches).toBe(1);
  await expect(page.getByText('schemaVersion must be 1', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Import selected (1)', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Duplicate canonical package ID');
  expect(submitted).toEqual({ paths: ['apps/known'], expectedCommit: commit });
  await expect(page.locator('.repository-package')).toContainText('v1.0.0');
  await page.getByRole('button', { name: 'Import history', exact: true }).click();
  const history = page.getByLabel('Package import history');
  await expect(history).toContainText('v2.0.0');
  await expect(history).toContainText('failed');
  await expect(history).toContainText('v1.0.0');
  await expect(history).toContainText('imported');
  await page.getByRole('button', { name: 'Import selected (1)', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'runtime registration needs attention' })).toContainText('worker unavailable');
});

test('Repositories clones a selected remote and adopts connector metadata without running it', async ({ page }) => {
  const id = randomUUID(), packageId = randomUUID(), commit = 'c'.repeat(40);
  const repository = { id, name: 'Cloned tools', remoteUrl: 'git@example.invalid:owner/tools.git', directory: '/tmp/cloned-tools', branch: 'operator/work', sourceBranch: 'master', status: 'ready' };
  let registered = false, adopted = false, cloneInput: unknown, adoptInput: unknown;
  await page.route('**/api/repositories', route => {
    if (route.request().method() === 'POST') { cloneInput = route.request().postDataJSON(); registered = true; return route.fulfill({ json: repository }); }
    return route.fulfill({ json: registered ? [repository] : [] });
  });
  const item = { id: packageId, repositoryId: id, kind: 'connector', name: 'analytics-tools', version: '0.1.0', path: 'tools/analytics', lastImportedCommit: commit, lastImportedAt: '2026-11-18T12:00:00Z' };
  await page.route('**/api/packages', route => route.fulfill(adopted ? { status: 503, json: { error: 'Temporary status refresh failure.' } } : { json: [] }));
  await page.route(`**/api/repositories/${id}/packages`, route => { adoptInput = route.request().postDataJSON(); adopted = true; return route.fulfill({ json: { ...item, notice: 'Source imported; runtime registration needs attention: account authorization required.' } }); });
  await login(page);
  await page.getByRole('button', { name: 'Repositories', exact: true }).click();
  await page.getByRole('button', { name: 'Add repository', exact: true }).click();
  await page.getByLabel('Repository name', { exact: true }).fill(repository.name);
  await page.getByLabel('Remote URL', { exact: true }).fill(repository.remoteUrl);
  await page.getByLabel('Start with', { exact: true }).selectOption('clone');
  await page.getByRole('button', { name: 'Register repository', exact: true }).click();
  await expect(page.getByRole('heading', { name: repository.name, exact: true })).toBeVisible();
  expect(cloneInput).toEqual({ name: repository.name, remoteUrl: repository.remoteUrl, mode: 'clone' });
  await page.getByRole('button', { name: 'Adopt folder', exact: true }).click();
  await page.getByLabel('Package kind', { exact: true }).selectOption('connector');
  await page.getByLabel('Package name', { exact: true }).fill('analytics-tools');
  await page.getByLabel('Folder in repository', { exact: true }).fill('tools/analytics');
  await page.getByLabel('MCP command', { exact: true }).fill('python3');
  await page.getByLabel('MCP arguments (one per line)', { exact: true }).fill('server.py\n--stdio');
  await expect(page.locator('.repository-package-editor')).toContainText('No build, check, or start command is executed.');
  await page.locator('.repository-package-editor').getByRole('button', { name: 'Adopt folder', exact: true }).click();
  await expect(page.locator('.repository-package')).toContainText('analytics-tools');
  await expect(page.locator('.repository-package-editor')).toHaveCount(0);
  await expect(page.getByRole('alert')).toContainText('Changes saved. Could not refresh repository status.');
  await expect(page.getByRole('status').filter({ hasText: 'runtime registration needs attention' })).toContainText('account authorization required');
  expect(adoptInput).toEqual({ kind: 'connector', name: 'analytics-tools', path: 'tools/analytics', version: '0.1.0', description: '', adopt: true, template: 'empty', mcp: { transport: 'stdio', command: 'python3', args: ['server.py', '--stdio'] } });
});

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
  await expect(page.getByRole('status').filter({ hasText: /Queue paused: worker disconnected|Queue waiting for task requirements/ })).toContainText('Your queued tasks are saved.');
  await expect(page.getByRole('status').filter({ hasText: /Queue paused: worker disconnected|Queue waiting for task requirements/ }).getByRole('button', { name: 'Connect agent' })).toBeVisible();
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
  const repository = await browserRepository(page);
  await page.getByRole('button', { name: 'Projects', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Projects', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Create project', exact: true }).click();
  const projectEditor = page.locator('.project-editor');
  await projectEditor.getByLabel('Project name', { exact: true }).fill('Browser project website');
  await projectEditor.getByLabel('Description', { exact: true }).fill('Keep the website and its operating context together.');
  await projectEditor.getByLabel('Git repository', { exact: true }).selectOption(repository.id);
  await projectEditor.getByLabel('Folder in repository', { exact: true }).fill('apps/browser-website');
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
  const source = { repositoryId: randomUUID(), packageId: id, repositoryPath: '/tmp/browser-repository', branch: 'operator/work', path: `projects/${id}`, workspacePath: `/tmp/browser-workspace/generated/projects/${id}`, commit: 'a'.repeat(40), dirty: false };
  const project = { id, name: 'Managed service fixture', description: 'Fixture source and release', origin: 'created', directory: `/srv/projects/${id}`, createdAt: '2026-11-15T10:00:00Z', updatedAt: '2026-11-15T10:00:00Z', status: 'running', lastCheckedAt: null, conversationIds: [], runs: [], components: [], connectorIds: [] as string[], source, deployment: { commit: 'b'.repeat(40), unitName: 'fixture-managed.service', releaseDirectory: '/srv/projects/releases/previous', status: 'running', detail: 'Fixture service is running.', checkedAt: new Date().toISOString() } };
  const connector = { id: connectorId, name: 'Fixture echo', description: 'Echo test tool', transport: 'stdio', command: 'node', args: ['server.mjs'], enabled: true, tools: [{ name: 'echo', inputSchema: { type: 'object' } }], status: 'connected', detail: 'Fixture', checkedAt: null };
  let files: Record<string, string> = { 'operator-package.json': JSON.stringify({ schemaVersion: 1, id, kind: 'project', name: project.name }), 'server.mjs': 'export const message = "before";\n' };
  let saves = 0, deployments = 0;
  const state = { worker: { uid: 0, root: true, pid: 42, activeRunId: null, runtime: { available: true, authenticated: true, version: 'fixture', detail: 'HTTP fixture only' } }, workerError: null, maintenance: false, queue: [] };
  await page.route('**/api/status', route => route.fulfill({ json: state }));
  await page.route('**/api/events?*', route => route.fulfill({ contentType: 'text/event-stream', body: `event: status\ndata: ${JSON.stringify(state)}\n\n` }));
  await page.route('**/api/projects', route => route.fulfill({ json: [project] }));
  await page.route('**/api/connectors', route => route.fulfill({ json: [connector] }));
  await page.route(`**/api/projects/${id}/environment`, route => route.fulfill({ json: { environment: null, readiness: { ready: true } } }));
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
  const repository = { id: '9d88b607-ffef-4783-9f70-fe350a90d3b0', name: 'Demo repository', remoteUrl: 'https://example.invalid/demo.git', directory: '/tmp/demo', branch: 'operator/work', status: 'ready' };
  await page.route('**/api/repositories', route => route.fulfill({ json: [repository] }));
  await page.route('**/api/connectors', route => route.fulfill({ json: registered ? [connector] : [] }));
  await page.route('**/api/connectors/examples', route => { expect(route.request().postDataJSON()).toEqual({ repositoryId: repository.id, packagePath: 'connectors/echo' }); registered = true; return route.fulfill({ json: connector }); });
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
  await page.getByLabel('Git repository', { exact: true }).selectOption(repository.id);
  await page.getByLabel('Folder in repository', { exact: true }).fill('connectors/echo');
  await page.getByRole('button', { name: 'Create demo package', exact: true }).click();
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
  await expect(editor).toContainText('configure credentials in Authentication.');
  await editor.getByLabel('MCP server URL').fill(connector.url);
  await editor.getByRole('button', { name: 'Add connection', exact: true }).click();
  await expect(page.getByRole('heading', { name: connector.name, exact: true })).toBeVisible();
  expect(submitted).toEqual({ name: connector.name, description: '', transport: 'http', projectId: null, enabled: true, url: connector.url });
});

async function sourceReviewFixture(page: Page, mode: 'legacy' | 'diverged' | 'current' = 'current') {
  const id = '944396de-488a-4412-9ad7-ac98f9abe875';
  const source = { workspaceDiverged: mode === 'diverged', repositoryId: mode === 'legacy' ? undefined : randomUUID(), packageId: id, repositoryPath: '/tmp/review-repository', branch: 'operator/work', path: `projects/${id}`, workspacePath: `/tmp/review-workspace/${id}`, commit: '1'.repeat(40), dirty: false };
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
  await page.route(`**/api/projects/${id}/environment`, route => route.fulfill({ json: { environment: null, readiness: { ready: true } } }));
  await page.route(`**/api/projects/${id}/source`, route => route.fulfill({ json: { source, manifest, files } }));
  return { project, projects, source, files, manifest, connectors };
}

test('legacy source remains readable and migration unlocks editing', async ({ page }) => {
  const { source, manifest, files, project } = await sourceReviewFixture(page, 'legacy');
  const repositoryId = randomUUID();
  await page.route('**/api/repositories', route => route.fulfill({ json: [{ id: repositoryId, name: 'Migration target', status: 'ready' }] }));
  await page.route(`**/api/projects/${project.id}/source/migrate`, route => {
    expect(route.request().postDataJSON()).toEqual({ repositoryId, packagePath: 'apps/service' });
    source.repositoryId = repositoryId;
    source.path = 'apps/service';
    return route.fulfill({ json: { source, manifest, files } });
  });
  await login(page);
  await page.getByRole('button', { name: 'Projects', exact: true }).click();
  const workspace = page.getByRole('region', { name: 'Source and deployment' });
  await workspace.getByLabel('Source file', { exact: true }).selectOption('server.mjs');
  await expect(workspace.getByLabel('Source code')).not.toBeEditable();
  await workspace.getByText('Move legacy source into a registered repository').click();
  await workspace.getByLabel('Git repository', { exact: true }).selectOption(repositoryId);
  await workspace.getByLabel('Folder in repository').fill('apps/service');
  await workspace.getByRole('button', { name: 'Migrate source' }).click();
  await expect(workspace.getByLabel('Source code')).toBeEditable();
});

test('a divergent checkout blocks source writes and permits deploying the imported revision', async ({ page }) => {
  await sourceReviewFixture(page, 'diverged');
  await login(page);
  await page.getByRole('button', { name: 'Projects', exact: true }).click();
  const workspace = page.getByRole('region', { name: 'Source and deployment' });
  await expect(workspace.getByRole('status')).toContainText('checkout differs from the imported revision');
  await expect(workspace.getByLabel('Source code')).not.toBeEditable();
  await expect(workspace.getByRole('button', { name: 'Add file', exact: true })).toBeDisabled();
  await expect(workspace.getByRole('button', { name: 'Deploy committed source', exact: true })).toBeEnabled();
});

test('adding a filename from the text editor preserves an existing binary asset and the rejected draft', async ({ page }) => {
  const { source, project, manifest, files } = await sourceReviewFixture(page);
  let submitted: unknown;
  await page.route(`**/api/projects/${project.id}/source`, route => {
    if (route.request().method() === 'GET') return route.fulfill({ json: { source, manifest, files } });
    submitted = route.request().postDataJSON();
    return route.fulfill({ status: 409, json: { error: 'This path exists in the package. Choose a different filename.' } });
  });
  await login(page);
  await page.getByRole('button', { name: 'Projects', exact: true }).click();
  const workspace = page.getByRole('region', { name: 'Source and deployment' });
  await workspace.getByLabel('Source file', { exact: true }).selectOption('server.mjs');
  await workspace.getByLabel('Source code').fill('first edit');
  await workspace.getByLabel('New source file path').fill('assets/logo.png');
  await workspace.getByRole('button', { name: 'Add file', exact: true }).click();
  await workspace.getByLabel('Source code').fill('new draft');
  await workspace.getByRole('button', { name: 'Save & commit', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Choose a different filename');
  expect(submitted).toEqual({ expectedCommit: source.commit, files: { 'assets/logo.png': 'new draft', 'server.mjs': 'first edit' }, createOnly: ['assets/logo.png'] });
  await expect(workspace.getByLabel('Source code')).toHaveValue('new draft');
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

async function conversationDeletionFixture(page: Page) {
  await page.addInitScript(() => {
    class FixtureEventSource extends EventTarget {
      onopen: ((event: Event) => void) | null = null;
      onerror: ((event: Event) => void) | null = null;
      constructor() { super(); (window as any).__conversationEventSource = this; queueMicrotask(() => this.onopen?.(new Event('open'))); }
      close() {}
    }
    Object.defineProperty(window, 'EventSource', { value: FixtureEventSource });
  });
  const now = '2026-11-16T10:00:00Z', first = { id: 'delete_first', title: 'Saved conversation', threadId: null, createdAt: now, updatedAt: now }, second = { ...first, id: 'delete_second', title: 'Other conversation' };
  const fixture = { rows: [first, second], deletions: [] as string[], error: '', gate: null as ReturnType<typeof deferred> | null, created: 0 };
  const state = { worker: null, workerError: null, maintenance: false, queue: [] };
  const detail = (conversation: typeof first) => ({ conversation, messages: [{ id: `message_${conversation.id}`, conversationId: conversation.id, runId: `run_${conversation.id}`, role: 'user', content: `${conversation.title} chat history`, createdAt: now }], runs: [], events: [] });
  await page.route('**/api/status', route => route.fulfill({ json: state }));
  await page.route('**/api/conversations', route => {
    if (route.request().method() === 'POST') { const conversation = { ...first, id: `delete_created_${++fixture.created}`, title: 'New conversation' }; fixture.rows = [conversation, ...fixture.rows]; return route.fulfill({ json: conversation }); }
    return route.fulfill({ json: fixture.rows });
  });
  await page.route('**/api/conversations/*', async route => {
    const id = new URL(route.request().url()).pathname.split('/').at(-1)!;
    if (route.request().method() === 'DELETE') {
      fixture.deletions.push(id); expect(route.request().headers()['x-csrf-token']).toBeTruthy();
      await fixture.gate?.promise;
      if (fixture.error) return route.fulfill({ status: 409, json: { error: fixture.error } });
      fixture.rows = fixture.rows.filter(conversation => conversation.id !== id); return route.fulfill({ json: { ok: true } });
    }
    const conversation = fixture.rows.find(value => value.id === id);
    return conversation ? route.fulfill({ json: detail(conversation) }) : route.fulfill({ status: 404, json: { error: 'Conversation has been deleted from the workspace.' } });
  });
  let seq = 10_000;
  const emit = async (type: string, conversationId: string | null, data: Record<string, unknown> = {}) => {
    await page.evaluate(value => (window as any).__conversationEventSource.dispatchEvent(new MessageEvent('event', { data: JSON.stringify(value) })), { seq: ++seq, type, conversationId, data, runId: null, createdAt: now });
  };
  return { fixture, first, second, detail, emit };
}

test('conversation deletion confirms removal, keeps unrelated drafts and deletes the last chat on a phone', async ({ page }) => {
  const { fixture, first, second } = await conversationDeletionFixture(page); await login(page);
  await expect(page.getByRole('heading', { name: first.title, exact: true })).toBeVisible();
  const composer = page.getByLabel('Message your operator'); await composer.fill('Keep this unrelated draft');
  page.once('dialog', dialog => dialog.dismiss()); await page.getByRole('button', { name: `Delete conversation "${second.title}"`, exact: true }).click();
  expect(fixture.deletions).toEqual([]); await expect(composer).toHaveValue('Keep this unrelated draft');
  let confirmation = ''; page.once('dialog', async dialog => { confirmation = dialog.message(); await dialog.accept(); });
  await page.getByRole('button', { name: `Delete conversation "${second.title}"`, exact: true }).click();
  await expect(page.locator('.conversation-link')).toHaveCount(1); expect(confirmation).toContain('Recovery and execution records'); expect(confirmation).toContain('running services are kept');
  await expect(composer).toHaveValue('Keep this unrelated draft'); await expect(page.getByRole('heading', { name: first.title, exact: true })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 }); await page.getByRole('button', { name: 'Open navigation' }).click();
  const remove = page.getByRole('button', { name: `Delete conversation "${first.title}"`, exact: true }); await expect(remove).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  page.once('dialog', dialog => dialog.accept()); await remove.click();
  await expect(page.locator('.conversation-link')).toHaveCount(0); await expect(page.getByRole('heading', { name: 'A fresh start', exact: true })).toBeVisible();
  await expect(composer).toHaveValue(''); await expect(page.getByTestId('message-user')).toHaveCount(0);
  expect(fixture.deletions).toEqual([second.id, first.id]);
});

test('a rejected conversation deletion keeps history and drafts and locks competing mutations while pending', async ({ page }) => {
  const { fixture, first, second } = await conversationDeletionFixture(page), gate = deferred(); fixture.gate = gate; fixture.error = 'Finish or reconcile pending work before deleting this conversation.';
  try {
    await login(page); await expect(page.getByRole('heading', { name: first.title, exact: true })).toBeVisible();
    const composer = page.getByLabel('Message your operator'); await composer.fill('Keep the current draft');
    page.once('dialog', dialog => dialog.accept()); await page.getByRole('button', { name: `Delete conversation "${first.title}"`, exact: true }).click();
    await expect.poll(() => fixture.deletions.length).toBe(1); await expect(composer).toBeDisabled(); await expect(page.locator('.new-conversation')).toBeDisabled(); await expect(page.locator('.conversation-link').filter({ hasText: second.title })).toBeDisabled();
    gate.resolve(); await expect(page.getByRole('alert')).toContainText(fixture.error); await expect(composer).toBeEnabled(); await expect(composer).toHaveValue('Keep the current draft');
    await expect(page.locator('.conversation-link')).toHaveCount(2); await expect(page.getByTestId('message-user')).toContainText(`${first.title} chat history`);
  } finally { gate.resolve(); }
});

test('deleted conversations stay removed after delayed list/detail reads and streamed events arrive', async ({ page }) => {
  const { fixture, first, second, detail, emit } = await conversationDeletionFixture(page), pending = deferred(); let lists = 0, details = 0;
  try {
    await login(page); await expect(page.getByRole('heading', { name: first.title, exact: true })).toBeVisible();
    const snapshot = [...fixture.rows];
    await page.route('**/api/conversations', async route => { if (route.request().method() !== 'GET') return route.fallback(); lists++; await pending.promise; return route.fulfill({ headers: { 'x-conversation-list-fixture': 'late' }, json: snapshot }); });
    await page.route(`**/api/conversations/${first.id}`, async route => { if (route.request().method() !== 'GET') return route.fallback(); details++; await pending.promise; return route.fulfill({ headers: { 'x-conversation-detail-fixture': 'late' }, json: detail(first) }); });
    await emit('run', first.id); await expect.poll(() => lists > 0 && details > 0).toBe(true);
    page.once('dialog', dialog => dialog.accept()); await page.getByRole('button', { name: `Delete conversation "${first.title}"`, exact: true }).click();
    await expect(page.getByRole('heading', { name: second.title, exact: true })).toBeVisible();
    const late = page.waitForResponse(response => response.headers()['x-conversation-detail-fixture'] === 'late'); pending.resolve(); await (await late).finished(); await nextPaint(page);
    await emit('message', first.id, { message: { id: 'late-deleted-message', role: 'user', content: 'Resurrected deleted text' } }); await emit('run', second.id); await nextPaint(page);
    await expect(page.locator('.conversation-link')).toHaveCount(1); await expect(page.locator('.conversation-link')).toContainText(second.title); await expect(page.getByTestId('message-user')).toContainText(`${second.title} chat history`); await expect(page.getByText('Resurrected deleted text')).toHaveCount(0);
  } finally { pending.resolve(); }
});

test('historical deletion replay cannot cancel the initial visible conversation list', async ({ page }) => {
  const { fixture, first, emit } = await conversationDeletionFixture(page), pending = deferred(); let reads = 0;
  const historical = { ...first, id: 'historical_deleted', title: 'Historical removed chat' }; fixture.rows = [historical, ...fixture.rows]; const snapshot = [...fixture.rows];
  await page.route('**/api/conversations', async route => { if (route.request().method() !== 'GET') return route.fallback(); reads++; await pending.promise; return route.fulfill({ json: snapshot }); });
  try {
    await login(page); await expect.poll(() => reads > 0).toBe(true); fixture.rows = fixture.rows.filter(conversation => conversation.id !== historical.id);
    await emit('conversation_deleted', null, { conversationId: historical.id }); pending.resolve();
    await expect(page.locator('.conversation-link')).toHaveCount(2); await expect(page.getByRole('heading', { name: first.title, exact: true })).toBeVisible(); await expect(page.locator('.conversation-link').filter({ hasText: historical.title })).toHaveCount(0);
  } finally { pending.resolve(); }
});

test('a delayed post-delete list cannot overwrite a newly created conversation', async ({ page }) => {
  const { fixture, first, second } = await conversationDeletionFixture(page), pending = deferred(); let reads = 0;
  try {
    await login(page); await expect(page.getByRole('heading', { name: first.title, exact: true })).toBeVisible();
    await page.route('**/api/conversations', async route => { if (route.request().method() !== 'GET') return route.fallback(); const snapshot = [...fixture.rows]; reads++; await pending.promise; return route.fulfill({ headers: { 'x-conversation-list-fixture': 'before-create' }, json: snapshot }); });
    page.once('dialog', dialog => dialog.accept()); await page.getByRole('button', { name: `Delete conversation "${second.title}"`, exact: true }).click(); await expect.poll(() => reads > 0).toBe(true);
    await page.locator('.new-conversation').click(); await expect(page.getByRole('heading', { name: 'New conversation', exact: true })).toBeVisible();
    await page.getByLabel('Message your operator').fill('Keep the newly created draft');
    const late = page.waitForResponse(response => response.headers()['x-conversation-list-fixture'] === 'before-create'); pending.resolve(); await (await late).finished(); await nextPaint(page);
    await expect(page.locator('.conversation-link')).toHaveCount(2); await expect(page.locator('.conversation-link').filter({ hasText: 'New conversation' })).toBeVisible(); await expect(page.getByLabel('Message your operator')).toHaveValue('Keep the newly created draft');
  } finally { pending.resolve(); }
});

test('local and remote conversation deletion preserve an unsaved project editor', async ({ page }) => {
  const { fixture, first, second, emit } = await conversationDeletionFixture(page); await sourceReviewFixture(page); await login(page);
  await expect(page.getByRole('heading', { name: first.title, exact: true })).toBeVisible(); await page.getByRole('button', { name: 'Projects', exact: true }).click();
  const workspace = page.getByRole('region', { name: 'Source and deployment' }), draft = 'export const value = "keep my source draft";\n';
  await workspace.getByLabel('Source file', { exact: true }).selectOption('server.mjs'); await workspace.getByLabel('Source code').fill(draft);
  fixture.rows = fixture.rows.filter(conversation => conversation.id !== first.id); await emit('conversation_deleted', null, { conversationId: first.id });
  await expect(workspace.getByLabel('Source code')).toHaveValue(draft); await expect(page.locator('.conversation-link')).toHaveCount(1);
  page.once('dialog', dialog => dialog.accept()); await page.getByRole('button', { name: `Delete conversation "${second.title}"`, exact: true }).click();
  await expect(page.locator('.conversation-link')).toHaveCount(0); await expect(workspace.getByLabel('Source code')).toHaveValue(draft);
  page.once('dialog', dialog => dialog.dismiss()); await page.getByRole('button', { name: 'Conversations', exact: true }).click(); await expect(workspace.getByLabel('Source code')).toHaveValue(draft);
});

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

async function removableProjectsFixture(page: Page) {
  const base = { description: 'Obsolete registration from an earlier projects directory.', origin: 'adopted', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), status: 'running', lastCheckedAt: null, conversationIds: [], runs: [], components: [] };
  const fixture = { projects: [
    { ...base, id: '782d9856-df9f-447f-8bb9-b059bb445b12', name: 'Obsolete website', directory: '/srv/previous-projects/obsolete-website' },
    { ...base, id: '2c8346b6-9dbb-4f86-a80d-d2c7ca1cadbc', name: 'Retained website', directory: '/home/legacy-projects/retained-website' },
  ], reads: 0 };
  const status = { worker: null, workerError: 'No worker fixture', maintenance: false, queue: [] };
  await page.route('**/api/status', route => route.fulfill({ json: status }));
  await page.route('**/api/events?*', route => route.fulfill({ contentType: 'text/event-stream', body: `event: status\ndata: ${JSON.stringify(status)}\n\n` }));
  await page.route('**/api/projects', route => { fixture.reads++; return route.fulfill({ json: fixture.projects }); });
  await page.route('**/api/connectors', route => route.fulfill({ json: [] }));
  return fixture;
}

test('project removal confirms metadata-only cleanup outside the current root without a worker', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const fixture = await removableProjectsFixture(page);
  const removed = fixture.projects[0]!, retained = fixture.projects[1]!;
  const pending = deferred(); let deletes = 0, confirmation = '';
  await page.route(`**/api/projects/${removed.id}`, async route => {
    expect(route.request().method()).toBe('DELETE');
    deletes++; await pending.promise;
    fixture.projects = fixture.projects.filter(project => project.id !== removed.id);
    return route.fulfill({ json: { ok: true } });
  });
  try {
    await login(page);
    await page.getByRole('button', { name: 'Open navigation' }).click();
    await page.getByRole('button', { name: 'Projects', exact: true }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Live status is unknown' })).toBeVisible();
    const remove = page.getByRole('button', { name: 'Remove project', exact: true });
    await expect(remove).toBeEnabled();
    page.once('dialog', async dialog => { confirmation = dialog.message(); await dialog.dismiss(); });
    await remove.click();
    expect(confirmation).toContain(removed.name); expect(confirmation).toContain(removed.directory);
    expect(confirmation).toContain('Source and runtime files, Git history, and conversations are kept.');
    expect(confirmation).toContain('project-owned connection registrations');
    expect(confirmation).toContain('Their assignments to other projects are also removed.');
    expect(confirmation).toContain('Existing services keep running.');
    expect(deletes).toBe(0);
    await expect(page.locator('.project-list-item')).toHaveCount(2);
    await expect(page.getByRole('heading', { name: removed.name, exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath('remove-project-phone.png'), animations: 'disabled' });
    const readsBeforeRemoval = fixture.reads;
    page.once('dialog', dialog => dialog.accept());
    await remove.click();
    await expect.poll(() => deletes).toBe(1);
    await expect(page.getByRole('button', { name: 'Removing project…', exact: true })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Create project', exact: true })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Ask operator', exact: true })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Add source', exact: true })).toBeDisabled();
    for (const item of await page.locator('.project-list-item').all()) await expect(item).toBeDisabled();
    pending.resolve();
    await expect(page.locator('.project-list-item').filter({ hasText: removed.name })).toHaveCount(0);
    await expect(page.getByRole('heading', { name: retained.name, exact: true })).toBeVisible();
    await expect(page.locator('.project-list-item.selected')).toContainText(retained.name);
    await expect(page.getByRole('button', { name: 'Remove project', exact: true })).toBeEnabled();
    await expect.poll(() => fixture.reads).toBeGreaterThan(readsBeforeRemoval);
    expect(deletes).toBe(1);
  } finally { pending.resolve(); }
});

test('project removal protects unsaved source and retains the registration after a backend error', async ({ page }) => {
  const fixture = await sourceReviewFixture(page);
  fixture.project.directory = '/srv/previous-projects/source-review';
  let deletes = 0;
  await page.route(`**/api/projects/${fixture.project.id}`, route => {
    expect(route.request().method()).toBe('DELETE'); deletes++;
    return route.fulfill({ status: 409, json: { error: 'This project has pending work. Resolve it before removing the registration.' } });
  });
  await login(page);
  await page.getByRole('button', { name: 'Projects', exact: true }).click();
  const workspace = page.getByRole('region', { name: 'Source and deployment' });
  await workspace.getByLabel('Source file', { exact: true }).selectOption('server.mjs');
  await workspace.getByLabel('Source code').fill('export const value = "keep my draft";\n');
  let warning = '';
  page.once('dialog', async dialog => { warning = dialog.message(); await dialog.dismiss(); });
  await page.getByRole('button', { name: 'Remove project', exact: true }).click();
  expect(warning).toContain('Discard unsaved source edits'); expect(deletes).toBe(0);
  const confirmations: string[] = [];
  const accept = async (dialog: import('@playwright/test').Dialog) => { confirmations.push(dialog.message()); await dialog.accept(); };
  page.on('dialog', accept);
  await page.getByRole('button', { name: 'Remove project', exact: true }).click();
  page.off('dialog', accept);
  await expect(page.getByRole('alert')).toContainText('This project has pending work.');
  expect(confirmations).toHaveLength(2);
  expect(confirmations[0]).toContain('Discard unsaved source edits');
  expect(confirmations[1]).toContain('Existing services keep running.');
  expect(deletes).toBe(1);
  await expect(page.locator('.project-list-item.selected')).toContainText(fixture.project.name);
  await expect(page.getByRole('heading', { name: fixture.project.name, exact: true })).toBeVisible();
  await expect(workspace.getByLabel('Source code')).toHaveValue('export const value = "keep my draft";\n');
  await expect(workspace.getByLabel('Source code')).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Remove project', exact: true })).toBeEnabled();
});

test('project removal ignores a stale list response that arrives after deletion', async ({ page }) => {
  await page.clock.install();
  const fixture = await removableProjectsFixture(page);
  const removed = fixture.projects[0]!, retained = fixture.projects[1]!;
  const stale = deferred(); let captureStale = false, staleStarted = false;
  await page.route('**/api/projects', async route => {
    if (captureStale && !staleStarted) {
      const oldProjects = [...fixture.projects]; staleStarted = true; await stale.promise;
      return route.fulfill({ json: oldProjects, headers: { 'x-removal-fixture': 'stale' } });
    }
    return route.fulfill({ json: fixture.projects });
  });
  await page.route(`**/api/projects/${removed.id}`, route => {
    expect(route.request().method()).toBe('DELETE');
    fixture.projects = fixture.projects.filter(project => project.id !== removed.id);
    return route.fulfill({ json: { ok: true } });
  });
  try {
    await login(page);
    await page.getByRole('button', { name: 'Projects', exact: true }).click();
    await expect(page.getByRole('heading', { name: removed.name, exact: true })).toBeVisible();
    captureStale = true;
    await page.clock.fastForward(15_100);
    await expect.poll(() => staleStarted).toBe(true);
    page.once('dialog', dialog => dialog.accept());
    await page.getByRole('button', { name: 'Remove project', exact: true }).click();
    await expect(page.getByRole('heading', { name: retained.name, exact: true })).toBeVisible();
    const lateResponse = page.waitForResponse(response => response.headers()['x-removal-fixture'] === 'stale');
    stale.resolve(); await lateResponse; await nextPaint(page);
    await expect(page.locator('.project-list-item').filter({ hasText: removed.name })).toHaveCount(0);
    await expect(page.locator('.project-list-item.selected')).toContainText(retained.name);
  } finally { stale.resolve(); }
});

function platformWorker(id: string, mode: 'user' | 'root' = 'user'): import('../src/workers/schemas').WorkerStatus {
  const now = new Date().toISOString();
  return { worker: { id, name: id === 'research' ? 'Research worker' : id === 'deploy' ? 'Deploy worker' : id, model: 'fixture-model', effort: 'low', mode, enabled: true, draining: false, createdAt: now, updatedAt: now }, connected: true, health: { connected: true, uid: mode === 'root' ? 0 : 1000, executionUid: mode === 'root' ? 0 : 1000, root: mode === 'root', pid: 42, activeRunId: null, uncertainRuns: [], runtimeOperations: [], workerId: id, journalId: randomUUID(), model: 'fixture-model', effort: 'low', workerMode: mode, runtime: { available: true, authenticated: true, version: 'fixture', detail: 'Observed HTTP fixture. No worker process or model is running.' } }, error: null, command: `fixture-start-worker ${id}` };
}

async function workerPlatformFixture(page: Page) {
  type Run = import('../src/shared').Run;
  type Connector = import('../src/connectors/schemas').Connector;
  const conversation = { id: 'platform_conversation', title: 'Platform fixture conversation', threadId: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  const project = { id: '6307ae41-578b-4fa3-8859-8fb33c242bfd', name: 'Automation workspace', description: 'Generic project fixture', origin: 'created', directory: '/tmp/platform-fixture/project', status: 'ready', components: [], runs: [], conversationIds: [conversation.id], connectorIds: ['4a8b2937-295e-4be7-92e7-ddb06c5a6917'], defaultWorkerId: 'research' as string | null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), lastCheckedAt: null };
  const connector: Connector = { id: project.connectorIds[0]!, name: 'Provider tools', description: 'Credential-aware fixture', transport: 'http', url: 'https://provider.example/mcp', enabled: true, projectId: project.id, tools: [{ name: 'echo', description: 'Fixture echo', inputSchema: { type: 'object' } }], status: 'connected', detail: 'Discovered fixture tool.', checkedAt: new Date().toISOString(), readiness: { ready: true }, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  const models: import('../src/workers/models-schema').WorkerModelCatalog = { models: [
    { id: 'fixture-analysis-model', name: 'Fixture Analysis', description: 'A model for building and analysis.', supportedEfforts: ['low', 'high'], defaultEffort: 'low', isDefault: true },
    { id: 'fixture-routine-model', name: 'Fixture Routine', description: 'A model for straightforward recurring tasks.', supportedEfforts: ['low'], defaultEffort: 'low', isDefault: false },
  ], source: 'worker' };
  const fixture = { workers: [platformWorker('research'), platformWorker('deploy', 'root')], models, project, connectors: [connector], runs: [] as Run[], jobs: [] as import('../src/jobs/schemas').Job[], credentials: [] as import('../src/credentials/schemas').CredentialMetadata[], connections: {} as Record<string, import('../src/agent-connection-schema').AgentConnection>, submitted: [] as Record<string, any>[] };
  for (const value of fixture.workers) fixture.connections[value.worker.id] = { state: 'connected', workerConnected: true, workerUid: value.health!.uid, executionUid: value.health!.uid };
  const status = () => ({ worker: fixture.workers[0]?.health ?? null, workers: fixture.workers, workerError: null, maintenance: false, queue: fixture.runs.filter(run => !['completed', 'failed', 'interrupted'].includes(run.status)) });
  const makeRun = (body: Record<string, any>, taskType: Run['taskType'] = 'interactive'): Run => ({ id: `platform_run_${fixture.runs.length + 1}`, conversationId: conversation.id, prompt: body.prompt, requestId: body.requestId || `scheduled_${fixture.runs.length + 1}`, kind: 'user', status: 'queued', summary: '', error: null, parentRunId: null, createdAt: new Date().toISOString(), startedAt: null, finishedAt: null, ...body, taskType });
  await page.route('**/api/status', route => route.fulfill({ json: status() }));
  await page.route('**/api/events?*', route => route.fulfill({ contentType: 'text/event-stream', body: `event: status\ndata: ${JSON.stringify(status())}\n\n` }));
  await page.route('**/api/worker-models', route => route.fulfill({ json: fixture.models }));
  await page.route('**/api/workers', route => {
    if (route.request().method() === 'POST') { const input = route.request().postDataJSON(); const value = platformWorker(input.id, input.mode); value.worker = { ...value.worker, ...input }; value.connected = false; value.health = null; fixture.workers.push(value); fixture.connections[input.id] = { state: 'disconnected', workerConnected: false, workerUid: null }; return route.fulfill({ json: value }); }
    return route.fulfill({ json: fixture.workers });
  });
  await page.route('**/api/workers/*', route => { const id = new URL(route.request().url()).pathname.split('/').at(-1)!; const value = fixture.workers.find(item => item.worker.id === id)!; Object.assign(value.worker, route.request().postDataJSON()); return route.fulfill({ json: value }); });
  await page.route('**/api/workers/*/*', route => {
    const [, , , id, action] = new URL(route.request().url()).pathname.split('/');
    const value = fixture.workers.find(item => item.worker.id === id)!;
    if (action === 'commands') return route.fulfill({ json: { command: value.command } });
    if (action === 'drain') { value.worker.draining = route.request().postDataJSON().draining; return route.fulfill({ json: value }); }
    if (action === 'start') { value.connected = true; value.health = platformWorker(id!, value.worker.mode).health; value.health!.model = value.worker.model; value.health!.effort = value.worker.effort; value.health!.runtime.model = value.worker.model ?? undefined; value.health!.runtime.authenticated = false; fixture.connections[id!] = { state: 'disconnected', workerConnected: true, workerUid: value.health!.uid, executionUid: value.health!.uid }; }
    if (action === 'connect') fixture.connections[id!] = { state: 'connecting', workerConnected: true, workerUid: value.health!.uid, verificationUrl: 'https://auth.openai.com/codex/device', userCode: 'WORKER-FIXTURE', expiresAt: new Date(Date.now() + 600_000).toISOString() };
    if (action === 'cancel') fixture.connections[id!] = { state: 'disconnected', workerConnected: true, workerUid: value.health!.uid };
    return route.fulfill({ json: fixture.connections[id!] });
  });
  await page.route('**/api/projects', route => route.fulfill({ json: [fixture.project] }));
  await page.route(`**/api/projects/${project.id}`, route => { Object.assign(fixture.project, route.request().postDataJSON()); return route.fulfill({ json: fixture.project }); });
  await page.route('**/api/connectors', route => route.fulfill({ json: fixture.connectors }));
  await page.route('**/api/credentials', route => {
    if (route.request().method() === 'POST') { const input = route.request().postDataJSON(); const value = { id: '4d936743-2a84-4bc5-b235-105f55db3c0e', name: input.name, kind: 'secret' as const, fields: Object.keys(input.values), revision: 1, ready: true, expiresAt: null, updatedAt: new Date().toISOString() }; fixture.credentials.push(value); return route.fulfill({ json: value }); }
    return route.fulfill({ json: fixture.credentials });
  });
  await page.route('**/api/connectors/*/auth', route => { const id = new URL(route.request().url()).pathname.split('/').at(-2)!; const value = fixture.connectors.find(item => item.id === id)!; value.auth = route.request().postDataJSON().auth ?? undefined; value.readiness = { ready: true }; return route.fulfill({ json: value }); });
  await page.route('**/api/conversations', route => route.fulfill({ json: [conversation] }));
  await page.route(`**/api/conversations/${conversation.id}`, route => route.fulfill({ json: { conversation, messages: [], runs: fixture.runs, events: [] } }));
  await page.route(`**/api/conversations/${conversation.id}/runs`, route => { const body = route.request().postDataJSON(); fixture.submitted.push(body); const run = makeRun(body); fixture.runs.push(run); return route.fulfill({ json: run }); });
  await page.route('**/api/runs/*', route => { const id = new URL(route.request().url()).pathname.split('/').at(-1)!; return route.fulfill({ json: fixture.runs.find(run => run.id === id) }); });
  await page.route('**/api/jobs', route => {
    if (route.request().method() === 'POST') { const input = route.request().postDataJSON(); const job = { ...input, id: '96059f81-bda8-47b4-9ec5-fb675b05dca3', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), nextRunAt: new Date(Date.now() + 300_000).toISOString(), lastRunAt: null, blockedReason: null, history: [] }; fixture.jobs.push(job); return route.fulfill({ json: job }); }
    return route.fulfill({ json: fixture.jobs });
  });
  await page.route('**/api/jobs/*', route => { const id = new URL(route.request().url()).pathname.split('/').at(-1)!; const job = fixture.jobs.find(item => item.id === id)!; const patch = route.request().postDataJSON(); Object.assign(job, patch); if (patch.requiredConnectorIds === null) delete job.requiredConnectorIds; return route.fulfill({ json: job }); });
  await page.route('**/api/jobs/*/*', route => {
    const [, , , id, action] = new URL(route.request().url()).pathname.split('/'); const job = fixture.jobs.find(item => item.id === id)!;
    if (action === 'pause') job.enabled = false;
    if (action === 'resume') job.enabled = true;
    if (action === 'run') { const run = makeRun({ ...job, id: `platform_scheduled_${fixture.runs.length + 1}`, prompt: job.prompt, workerId: job.workerId || fixture.project.defaultWorkerId }, 'scheduled'); fixture.runs.push(run); job.history.push({ runId: run.id, scheduledFor: `manual:${randomUUID()}`, status: run.status, workerId: run.workerId ?? null, model: null }); }
    return route.fulfill({ json: job });
  });
  return { fixture, makeRun, conversation };
}

test('Workers registers user-mode profiles, signs in independently, and drains admission', async ({ page, context }, testInfo) => {
  await page.clock.install(); await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  const { fixture } = await workerPlatformFixture(page);
  await login(page); await page.getByRole('button', { name: 'Workers', exact: true }).click();
  await page.getByRole('button', { name: 'Register worker', exact: true }).click();
  await expect(page.getByLabel('Worker mode', { exact: true })).toHaveValue('user');
  await page.getByLabel('Worker name', { exact: true }).fill('Analysis worker');
  await page.getByLabel('Worker ID', { exact: true }).fill('analysis');
  await page.getByLabel('Worker model', { exact: true }).selectOption('fixture-analysis-model');
  await page.getByLabel('Worker effort', { exact: true }).selectOption('high');
  await page.locator('.platform-editor').getByRole('button', { name: 'Register worker', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Analysis worker', exact: true })).toBeVisible();
  expect(fixture.workers.find(value => value.worker.id === 'analysis')!.worker.mode).toBe('user');
  await page.getByRole('button', { name: 'Copy startup command' }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('fixture-start-worker analysis');
  await page.getByRole('button', { name: 'Start worker', exact: true }).click();
  await page.getByRole('button', { name: 'Connect ChatGPT', exact: true }).click();
  await expect(page.getByLabel('Worker sign-in code')).toHaveText('WORKER-FIXTURE');
  await page.getByRole('button', { name: 'Cancel sign-in', exact: true }).click();
  await page.getByRole('button', { name: 'Connect ChatGPT', exact: true }).click();
  const value = fixture.workers.find(item => item.worker.id === 'analysis')!; value.health!.runtime.authenticated = true;
  fixture.connections.analysis = { state: 'connected', workerConnected: true, workerUid: 1000, executionUid: 1000 };
  await page.clock.fastForward(5100);
  await expect(page.getByRole('status').filter({ hasText: 'ChatGPT sign-in is ready for this worker.' })).toBeVisible();
  await page.getByRole('button', { name: 'Drain worker', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'New tasks wait while this worker drains.' })).toBeVisible();
  expect(value.worker.draining).toBe(true);
  await page.getByRole('button', { name: 'Resume admission', exact: true }).click();
  await page.getByRole('button', { name: 'Edit worker', exact: true }).click();
  await expect(page.getByLabel('Worker model', { exact: true })).toHaveCount(0);
  await page.getByLabel('Worker name', { exact: true }).fill('Renamed analysis worker');
  await page.getByRole('button', { name: 'Save worker', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Renamed analysis worker', exact: true })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('workers-phone.png'), animations: 'disabled' });
});

test('worker registration selects catalog models and clears reasoning effort unsupported by a new model', async ({ page }) => {
  await workerPlatformFixture(page);
  await login(page); await page.getByRole('button', { name: 'Workers', exact: true }).click();
  await page.getByRole('button', { name: 'Register worker', exact: true }).click();
  const editor = page.locator('.platform-editor'), model = page.getByRole('combobox', { name: 'Worker model', exact: true }), effort = page.getByRole('combobox', { name: 'Worker effort', exact: true });
  await expect(model).toHaveValue(''); await expect(editor.getByRole('button', { name: 'Register worker', exact: true })).toBeDisabled();
  await model.selectOption('fixture-analysis-model');
  await expect(model.locator('option:checked')).toHaveText('Fixture Analysis · fixture-analysis-model · default');
  await expect(editor).toContainText('A model for building and analysis.');
  await expect(effort.locator('option')).toHaveText(['Model default (low)', 'low', 'high']);
  await effort.selectOption('high'); await model.selectOption('fixture-routine-model');
  await expect(effort).toHaveValue(''); await expect(effort.locator('option')).toHaveText(['Model default (low)', 'low']);
  await expect(editor).toContainText('A model for straightforward recurring tasks.');
  await page.getByLabel('Worker name', { exact: true }).fill('Routine worker'); await page.getByLabel('Worker ID', { exact: true }).fill('routine');
  const submitted = page.waitForRequest(request => request.method() === 'POST' && new URL(request.url()).pathname === '/api/workers');
  await editor.getByRole('button', { name: 'Register worker', exact: true }).click();
  const input = (await submitted).postDataJSON(); expect(input.model).toBe('fixture-routine-model'); expect(input).not.toHaveProperty('effort');
  await expect(page.getByRole('heading', { name: 'Routine worker', exact: true })).toBeVisible();
});

test('worker model loading, errors and empty catalogs preserve the registration draft through retries', async ({ page }) => {
  const { fixture } = await workerPlatformFixture(page), pending = deferred();
  let phase: 'loading' | 'empty' | 'available' = 'loading', started = false;
  await page.route('**/api/worker-models', async route => {
    const current = phase;
    if (current === 'loading') { started = true; await pending.promise; return route.fulfill({ status: 503, json: { error: 'Model catalog temporarily unavailable.' } }); }
    if (current === 'empty') return route.fulfill({ json: { models: [], source: 'unavailable', detail: 'Start a worker to load its model catalog.' } });
    return route.fulfill({ json: { ...fixture.models, source: 'cache', detail: 'Showing the saved model catalog. Availability is checked when this worker starts.' } });
  });
  try {
    await login(page); await page.getByRole('button', { name: 'Workers', exact: true }).click(); await page.getByRole('button', { name: 'Register worker', exact: true }).click();
    await expect.poll(() => started).toBe(true);
    const editor = page.locator('.platform-editor'), model = page.getByLabel('Worker model', { exact: true });
    await page.getByLabel('Worker name', { exact: true }).fill('Keep my draft'); await page.getByLabel('Worker ID', { exact: true }).fill('keep-draft');
    await expect(model).toBeDisabled(); await expect(editor.getByRole('status')).toHaveText('Loading available Codex models…'); await expect(editor.getByRole('button', { name: 'Register worker', exact: true })).toBeDisabled();
    pending.resolve(); await expect(editor.getByRole('alert')).toHaveText('Model catalog temporarily unavailable.');
    await expect(page.getByLabel('Worker name', { exact: true })).toHaveValue('Keep my draft');
    phase = 'empty'; await editor.getByRole('button', { name: 'Reload models', exact: true }).click();
    await expect(editor.getByRole('status')).toHaveText('Start a worker to load its model catalog.'); await expect(model).toBeDisabled();
    phase = 'available'; await editor.getByRole('button', { name: 'Reload models', exact: true }).click();
    await expect(model).toBeEnabled(); await expect(editor).toContainText('Showing the saved model catalog.'); await expect(editor.getByRole('alert')).toHaveCount(0);
    await expect(page.getByLabel('Worker ID', { exact: true })).toHaveValue('keep-draft'); await model.selectOption('fixture-analysis-model');
    await expect(editor.getByRole('button', { name: 'Register worker', exact: true })).toBeEnabled();
  } finally { pending.resolve(); }
});

test('a late model catalog response cannot replace the current model selection', async ({ page }) => {
  const { fixture } = await workerPlatformFixture(page), late = deferred(); let calls = 0;
  await page.route('**/api/worker-models', async route => {
    if (++calls === 1) { await late.promise; return route.fulfill({ headers: { 'x-model-catalog-fixture': 'late' }, json: { ...fixture.models, models: [fixture.models.models[0]] } }); }
    return route.fulfill({ json: fixture.models });
  });
  try {
    await login(page); await page.getByRole('button', { name: 'Workers', exact: true }).click(); await page.getByRole('button', { name: 'Register worker', exact: true }).click();
    // Development StrictMode starts a replacement load before the first response completes.
    const model = page.getByLabel('Worker model', { exact: true }); await model.selectOption('fixture-routine-model');
    await page.getByLabel('Worker effort', { exact: true }).selectOption('low');
    const response = page.waitForResponse(value => value.headers()['x-model-catalog-fixture'] === 'late'); late.resolve(); await response; await nextPaint(page);
    await expect(model).toHaveValue('fixture-routine-model'); await expect(page.getByLabel('Worker effort', { exact: true })).toHaveValue('low');
    await expect(model.locator('option[value="fixture-routine-model"]')).toHaveCount(1);
    await expect(page.locator('.platform-editor').getByRole('alert')).toHaveCount(0);
  } finally { late.resolve(); }
});

test('task routing captures worker/root grants, project defaults, provenance, usage, and blocked reasons', async ({ page }) => {
  const { fixture, makeRun } = await workerPlatformFixture(page);
  fixture.runs.push({ ...makeRun({ prompt: 'Completed delegated fixture', requestId: 'completed_fixture' }), id: 'platform_completed_child', status: 'completed', assignedWorkerId: 'research', model: 'fixture-model', effort: 'low', taskType: 'delegated', parentRunId: 'platform_parent', usage: { total: { inputTokens: 12, outputTokens: 8, totalTokens: 20 } }, finishedAt: new Date().toISOString() });
  fixture.runs.push({ ...makeRun({ prompt: 'Parent fixture task', requestId: 'parent_fixture' }), id: 'platform_parent', status: 'completed' });
  await login(page);
  await expect(page.locator('.topbar').getByRole('button', { name: 'Manage workers' })).toBeVisible();
  await expect(page.locator('.run-execution-metadata').filter({ hasText: 'Worker research' })).toContainText('fixture-model · low');
  await expect(page.getByText('12 input · 8 output · 20 total tokens', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Projects', exact: true }).click();
  const projectWorker = page.getByRole('region', { name: 'Project default worker', exact: true });
  await projectWorker.getByLabel('Project default worker', { exact: true }).selectOption('deploy');
  await projectWorker.getByRole('button', { name: 'Save default worker' }).click();
  await expect(projectWorker.getByRole('button', { name: 'Default worker saved' })).toBeVisible();
  expect(fixture.project.defaultWorkerId).toBe('deploy');
  await page.getByRole('navigation', { name: 'Workspace' }).getByRole('button', { name: /^Conversations/ }).click();
  await page.getByLabel('Task worker', { exact: true }).selectOption('deploy');
  await expect(page.locator('.composer .task-constraints')).toHaveAttribute('open', '');
  await expect(page.locator('.composer').getByRole('checkbox', { name: 'Requires root access' })).toBeChecked();
  await page.getByLabel('Maximum tool calls', { exact: true }).fill('4');
  await page.getByLabel('Task connection scope', { exact: true }).selectOption('explicit');
  await page.getByLabel('Message your operator').fill('Explicit root task fixture');
  await page.getByRole('button', { name: 'Send message' }).click();
  await expect.poll(() => fixture.submitted.length).toBe(1);
  expect(fixture.submitted[0]).toMatchObject({ workerId: 'deploy', requiredRoot: true, maxToolCalls: 4, requiredConnectorIds: [] });
  fixture.runs.at(-1)!.blockedReason = 'Assigned worker is draining. Task remains queued.';
  fixture.workers[1]!.worker.draining = true;
  await page.getByRole('button', { name: /^Parent task/ }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Assigned worker is draining.' }).first()).toBeVisible();
  expect(fixture.submitted).toHaveLength(1);
});

test('worker readiness excludes unresolved runtime operations, sign-in transitions and reserved replacement', async ({ page }) => {
  await page.clock.install();
  const { fixture } = await workerPlatformFixture(page);
  fixture.workers[0]!.health!.runtimeOperations = [{ id: 'runtime_fixture_uncertain', method: 'connectors/call', status: 'uncertain', requiresExternalInspection: true }];
  fixture.workers[1]!.health!.runtimeOperations = [{ id: 'runtime_fixture_running', method: 'managed/deploy', status: 'running', requiresExternalInspection: false }];
  await login(page); await page.getByRole('button', { name: 'Workers', exact: true }).click();
  await expect(page.locator('.privilege-pill')).toHaveText('0/2 ready');
  await expect(page.locator('.workers-panel .project-list-item').filter({ hasText: 'Research worker' })).toContainText('Needs inspection');
  await expect(page.locator('.workers-panel .project-list-item').filter({ hasText: 'Deploy worker' })).toContainText('Busy');
  fixture.workers[0]!.health!.runtimeOperations = []; fixture.workers[0]!.health!.runtime.authenticating = true;
  fixture.workers[1]!.health!.runtimeOperations = []; fixture.workers[1]!.health!.replacementReserved = true;
  await page.clock.fastForward(5100);
  await expect(page.locator('.privilege-pill')).toHaveText('0/2 ready');
  await expect(page.locator('.workers-panel .project-list-item').filter({ hasText: 'Research worker' })).toContainText('Signing in');
  await expect(page.locator('.workers-panel .project-list-item').filter({ hasText: 'Deploy worker' })).toContainText('Restart reserved');
  fixture.workers[0]!.health!.runtime.authenticating = false; fixture.workers[1]!.health!.replacementReserved = false;
  await page.clock.fastForward(5100);
  await expect(page.locator('.privilege-pill')).toHaveText('2/2 ready');
});

test('Jobs saves interval and cron templates, pauses/resumes, queues once, and opens history', async ({ page }, testInfo) => {
  const { fixture } = await workerPlatformFixture(page);
  await login(page); await page.getByRole('button', { name: 'Jobs', exact: true }).click();
  await page.getByRole('button', { name: 'Create job', exact: true }).click();
  await page.getByLabel('Job name', { exact: true }).fill('Scheduled analysis');
  await page.getByLabel('Job project', { exact: true }).selectOption(fixture.project.id);
  await page.getByLabel('Job task prompt', { exact: true }).fill('Read the required tools and write a bounded report.');
  await page.getByLabel('Job interval seconds', { exact: true }).fill('60');
  await page.getByLabel('Task worker', { exact: true }).selectOption('research');
  await page.locator('.platform-editor').getByText('Execution options', { exact: true }).click();
  await page.getByLabel('Task connection scope', { exact: true }).selectOption('explicit');
  await page.getByRole('checkbox', { name: 'Provider tools', exact: true }).check();
  await page.getByLabel('Maximum tool calls', { exact: true }).fill('5');
  await page.locator('.platform-editor').getByRole('button', { name: 'Create job', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Scheduled analysis', exact: true })).toBeVisible();
  expect(fixture.jobs[0]).toMatchObject({ projectId: fixture.project.id, workerId: 'research', requiredRoot: false, maxToolCalls: 5, schedule: { type: 'interval', seconds: 60 }, requiredConnectorIds: fixture.project.connectorIds });
  await page.getByRole('button', { name: 'Pause job', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Resume job', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Resume job', exact: true }).click();
  await page.getByRole('button', { name: 'Edit job', exact: true }).click();
  await page.getByLabel('Job schedule type', { exact: true }).selectOption('cron');
  await page.getByLabel('Job cron expression', { exact: true }).fill('0 9 * * 1-5');
  await page.getByLabel('Job timezone', { exact: true }).fill('Europe/Paris');
  await page.locator('.platform-editor').getByText('Execution options', { exact: true }).click();
  await page.getByLabel('Task connection scope', { exact: true }).selectOption('project');
  await page.getByRole('button', { name: 'Save job', exact: true }).click();
  await expect(page.getByText('0 9 * * 1-5 · Europe/Paris', { exact: true }).last()).toBeVisible();
  expect(fixture.jobs[0]!.requiredConnectorIds).toBeUndefined();
  await expect(page.getByText('Inherit project connections', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Run once', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Job history' })).toContainText('queued');
  await expect(page.getByRole('region', { name: 'Job history' })).toContainText('Manual run');
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('jobs-phone.png'), animations: 'disabled' });
  await page.getByRole('region', { name: 'Job history' }).getByRole('button').click();
  await expect(page.getByText('scheduled', { exact: true })).toBeVisible();
});

test('job history labels manual and event triggers without treating their keys as dates', async ({ page }) => {
  const { fixture, makeRun } = await workerPlatformFixture(page);
  const now = new Date().toISOString();
  const runs = [makeRun({ prompt: 'Scheduled fixture' }), makeRun({ prompt: 'Manual fixture' }), makeRun({ prompt: 'Event fixture' })].map((run, index) => ({ ...run, id: `history_${index}`, status: 'completed' as const }));
  fixture.runs.push(...runs);
  fixture.jobs.push({ id: randomUUID(), projectId: fixture.project.id, name: 'Trigger history', prompt: 'Produce a bounded report.', enabled: true, schedule: { type: 'interval', seconds: 300 }, createdAt: now, updatedAt: now, nextRunAt: now, lastRunAt: now, blockedReason: null, history: runs.map((run, index) => ({ runId: run.id, scheduledFor: [now, `manual:${randomUUID()}`, 'event:bar-42'][index]!, status: run.status, workerId: 'research', model: 'fixture-model' })) });
  await login(page); await page.getByRole('button', { name: 'Jobs', exact: true }).click();
  const history = page.getByRole('region', { name: 'Job history' });
  await expect(history).toContainText('Manual run'); await expect(history).toContainText('Event: bar-42');
  await expect(history).not.toContainText('Invalid Date');
  await expect(history.getByRole('button')).toHaveCount(3);
});

test('Connections stores and rotates write-only credentials without reading secret values back', async ({ page }) => {
  const { fixture } = await workerPlatformFixture(page);
  fixture.connectors[0]!.readiness = { ready: false, reason: 'Configure credentials in Connections.' };
  let created: Record<string, any> | undefined, rotated: Record<string, any> | undefined;
  await page.route('**/api/credentials', route => {
    if (route.request().method() === 'POST') { created = route.request().postDataJSON(); const value = { id: '8fc16773-9015-44fd-a9c9-c14ff376a395', name: created!.name, kind: 'secret' as const, fields: ['token'], revision: 1, ready: true, expiresAt: null, updatedAt: new Date().toISOString() }; fixture.credentials.push(value); return route.fulfill({ json: value }); }
    return route.fulfill({ json: fixture.credentials });
  });
  await page.route('**/api/credentials/*', route => { expect(route.request().method()).toBe('PUT'); rotated = route.request().postDataJSON(); fixture.credentials[0]!.revision++; return route.fulfill({ json: fixture.credentials[0] }); });
  await login(page); await page.getByRole('button', { name: 'Connections', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Test connection', exact: true })).toBeDisabled();
  const setup = page.getByRole('region', { name: 'Connection credentials' });
  await setup.getByLabel('Connection authentication method').selectOption('bearer');
  await setup.getByLabel('Credential name', { exact: true }).fill('Provider account key');
  await setup.getByLabel('Credential field 1 value', { exact: true }).fill('fixture-write-only-token');
  await setup.getByRole('button', { name: 'Save credentials & binding', exact: true }).click();
  await expect(setup.getByRole('status').filter({ hasText: 'Credential saved and granted' })).toBeVisible();
  expect(created).toMatchObject({ name: 'Provider account key', values: { token: 'fixture-write-only-token' } });
  expect(fixture.connectors[0]!.auth).toEqual({ type: 'bearer', credentialId: fixture.credentials[0]!.id, field: 'token' });
  await expect(setup.getByLabel('Credential field 1 value', { exact: true })).toHaveValue('');
  await expect(page.locator('body')).not.toContainText('fixture-write-only-token');
  expect(await page.evaluate(() => JSON.stringify(localStorage))).not.toContain('fixture-write-only-token');
  await setup.getByLabel('Credential field 1 value', { exact: true }).fill('fixture-rotated-token');
  await setup.getByRole('button', { name: 'Save credentials & binding', exact: true }).click();
  await expect.poll(() => rotated).toEqual({ values: { token: 'fixture-rotated-token' } });
  await expect(setup.getByLabel('Credential field 1 value', { exact: true })).toHaveValue('');
  await expect(page.getByRole('button', { name: 'Test connection', exact: true })).toBeEnabled();
});

test('Connections OAuth setup opens a provider flow, supports cancellation, and observes readiness', async ({ page }, testInfo) => {
  await page.clock.install();
  const { fixture } = await workerPlatformFixture(page);
  const id = fixture.connectors[0]!.id; let authorized = false, starts = 0, cancellations = 0;
  const credential = { id: 'ee1b2fcb-2a52-4990-9dd4-27368ab1dbd8', name: 'Provider OAuth', kind: 'oauth2' as const, fields: [] as string[], revision: 1, ready: false, expiresAt: null, updatedAt: new Date().toISOString() };
  await page.route(`**/api/connectors/${id}/oauth/start`, route => { const body = route.request().postDataJSON(); expect(body.clientSecret).toBe('fixture-client-secret'); expect(body.tokenMethod).toBe('GET'); expect(body.tokenFields).toEqual({ accessToken: 'access_token_value', refreshToken: 'refresh_token_value', expiresIn: 'expires_in' }); starts++; fixture.connectors[0]!.auth = { type: 'oauth2', credentialId: credential.id }; fixture.connectors[0]!.readiness = { ready: false, reason: 'Authorization pending.' }; if (!fixture.credentials.length) fixture.credentials.push(credential); return route.fulfill({ json: { authorizationUrl: 'https://provider.example/authorize?state=fixture', expiresAt: new Date(Date.now() + 600_000).toISOString(), credential } }); });
  await page.route(`**/api/connectors/${id}/oauth/status`, route => route.fulfill({ json: { readiness: { ready: authorized, ...(authorized ? {} : { reason: 'Authorization pending.' }) }, credential: { ...credential, ready: authorized } } }));
  await page.route(`**/api/connectors/${id}/oauth/cancel`, route => { cancellations++; return route.fulfill({ json: { ok: true } }); });
  await login(page); await page.getByRole('button', { name: 'Connections', exact: true }).click();
  const setup = page.getByRole('region', { name: 'Connection credentials' });
  await setup.getByLabel('Connection authentication method').selectOption('oauth2');
  await setup.getByLabel('OAuth authorization URL').fill('https://provider.example/authorize');
  await setup.getByLabel('OAuth token URL').fill('https://provider.example/token');
  await setup.getByLabel('OAuth client ID').fill('fixture-public-client');
  await setup.getByLabel('OAuth client authentication').selectOption('client_secret_post');
  await setup.getByLabel('OAuth client secret').fill('fixture-client-secret');
  await setup.getByLabel('OAuth scopes').fill('read:data write:reports');
  await setup.getByText('Advanced token settings', { exact: true }).click();
  await setup.getByLabel('OAuth token request method', { exact: true }).selectOption('GET');
  await setup.getByLabel('OAuth access token response field', { exact: true }).fill('access_token_value');
  await setup.getByLabel('OAuth refresh token response field', { exact: true }).fill('refresh_token_value');
  await setup.getByRole('button', { name: 'Start account authorization' }).click();
  await expect(setup.getByRole('link', { name: 'Open provider authorization' })).toHaveAttribute('href', 'https://provider.example/authorize?state=fixture');
  await expect(setup.getByLabel('OAuth client secret')).toHaveValue('');
  await setup.getByRole('button', { name: 'Cancel authorization', exact: true }).click();
  expect(cancellations).toBe(1);
  await setup.getByLabel('OAuth client secret').fill('fixture-client-secret');
  await setup.getByRole('button', { name: 'Start account authorization' }).click();
  authorized = true; fixture.connectors[0]!.readiness = { ready: true }; credential.ready = true;
  await page.clock.fastForward(2100);
  await expect(setup.getByRole('status').filter({ hasText: 'Account authorization is ready.' })).toBeVisible();
  expect(starts).toBe(2);
  await expect(page.locator('body')).not.toContainText('fixture-client-secret');
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('connection-auth-phone.png'), animations: 'disabled' });
});

test('project runtime credentials save references, reject duplicate bindings, and clear without restarting services', async ({ page }, testInfo) => {
  const fixture = await sourceReviewFixture(page);
  const credential = { id: 'a9a5fae9-2760-43f5-8b81-cd5c0f7c0091', name: 'Runtime provider account', kind: 'secret', fields: ['key', 'secret'], revision: 1, ready: true, expiresAt: null, updatedAt: new Date().toISOString() };
  let environment: import('../src/credentials/schemas').ProjectEnvironment | null = null;
  const writes: unknown[] = [], serviceActions: string[] = [];
  await page.route('**/api/credentials', route => { expect(route.request().method()).toBe('GET'); return route.fulfill({ json: [credential] }); });
  await page.route(`**/api/projects/${fixture.project.id}/environment`, route => {
    if (route.request().method() === 'PUT') { const input = route.request().postDataJSON(); writes.push(input); environment = input.environment; }
    return route.fulfill({ json: { environment, readiness: { ready: true } } });
  });
  await page.route(`**/api/projects/${fixture.project.id}/deploy`, route => { serviceActions.push('deploy'); return route.fulfill({ status: 500, json: { error: 'Services must not be changed by credential setup.' } }); });
  await page.route(`**/api/projects/${fixture.project.id}/deployment/stop`, route => { serviceActions.push('stop'); return route.fulfill({ status: 500, json: { error: 'Services must not be changed by credential setup.' } }); });
  await login(page); await page.getByRole('button', { name: 'Projects', exact: true }).click();
  const setup = page.getByRole('region', { name: 'Runtime credentials', exact: true });
  await setup.getByLabel('Runtime saved credential', { exact: true }).selectOption(credential.id);
  await expect(setup).toContainText('Available fields: key, secret');
  await setup.getByLabel('Runtime environment bindings', { exact: true }).fill('API_KEY=key\nAPI_KEY=secret');
  await setup.getByRole('button', { name: 'Save runtime credentials', exact: true }).click();
  await expect(setup.getByRole('alert')).toHaveText('Each environment variable can be bound only once.');
  expect(writes).toEqual([]);
  await setup.getByLabel('Runtime environment bindings', { exact: true }).fill('API_KEY=key\nAPI_SECRET=secret');
  await setup.getByRole('button', { name: 'Save runtime credentials', exact: true }).click();
  await expect(setup.getByRole('status')).toContainText('Redeploy to apply it before restarting the old unit.');
  expect(writes).toEqual([{ environment: { credentialId: credential.id, bindings: { API_KEY: 'key', API_SECRET: 'secret' } } }]);
  await page.setViewportSize({ width: 390, height: 844 });
  await setup.scrollIntoViewIfNeeded();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('runtime-credentials-phone.png'), animations: 'disabled' });
  await setup.getByRole('button', { name: 'Clear runtime credentials', exact: true }).click();
  await expect(setup.getByRole('status')).toContainText('Runtime credential binding cleared.');
  await expect(setup.getByLabel('Runtime saved credential', { exact: true })).toHaveValue('');
  await expect(setup.getByLabel('Runtime environment bindings', { exact: true })).toHaveValue('');
  await expect(setup.getByRole('button', { name: 'Clear runtime credentials', exact: true })).toBeDisabled();
  expect(writes[1]).toEqual({ environment: null });
  expect(serviceActions).toEqual([]);
});

test('Jobs returns event tokens once, clears them after copy or close, and discards late responses', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  const { fixture } = await workerPlatformFixture(page);
  const id = '4ab46725-98e1-43c9-89e6-28b7f75da455';
  fixture.jobs.push({ id, name: 'Provider event template', projectId: fixture.project.id, prompt: 'Process the supplied event once.', schedule: { type: 'interval', seconds: 300 }, enabled: false, workerId: 'research', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), nextRunAt: null, lastRunAt: null, blockedReason: null, history: [] });
  const late = deferred(); let generated = 0;
  await page.route(`**/api/jobs/${id}/trigger-token`, async route => {
    expect(route.request().method()).toBe('POST'); generated++;
    if (generated === 3) await late.promise;
    const credential = { id: 'f779dd19-f648-4e8e-8904-4365c4831a34', name: 'Provider event template event token', kind: 'secret' as const, fields: ['token'], revision: generated, ready: true, expiresAt: null, updatedAt: new Date().toISOString() };
    return route.fulfill({ json: { token: `fixture-once-only-token-${generated}`, endpoint: `/api/job-events/${id}`, credential } });
  });
  try {
    await login(page); await page.getByRole('button', { name: 'Jobs', exact: true }).click();
    const section = page.locator('details').filter({ has: page.locator('summary', { hasText: 'Event-triggered execution' }) });
    await section.locator('summary').click();
    await section.getByRole('button', { name: 'Generate event token', exact: true }).click();
    const token = section.getByLabel('One-time job event token', { exact: true });
    await expect(token).toHaveValue('fixture-once-only-token-1');
    await expect(token).toHaveAttribute('type', 'password');
    await expect(section.getByLabel('Job event endpoint')).toHaveText(`/api/job-events/${id}`);
    await expect(section).toContainText('Saved credential: Provider event template event token');
    await section.getByRole('button', { name: 'Show event token', exact: true }).click();
    await expect(token).toHaveAttribute('type', 'text');
    await section.getByRole('button', { name: 'Hide event token', exact: true }).click();
    await section.getByRole('button', { name: 'Copy event token', exact: true }).click();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('fixture-once-only-token-1');
    await expect(token).toHaveCount(0);
    await expect(section.getByRole('status')).toContainText('Token copied.');
    expect(await page.evaluate(() => JSON.stringify({ local: localStorage, session: sessionStorage }))).not.toContain('fixture-once-only-token');
    await section.getByRole('button', { name: 'Generate event token', exact: true }).click();
    await expect(token).toHaveValue('fixture-once-only-token-2');
    await section.locator('summary').click(); await section.locator('summary').click();
    await expect(token).toHaveCount(0);
    await section.getByRole('button', { name: 'Generate event token', exact: true }).click();
    await expect.poll(() => generated).toBe(3);
    await section.locator('summary').click();
    const response = page.waitForResponse(`**/api/jobs/${id}/trigger-token`);
    late.resolve(); await response; await nextPaint(page);
    await section.locator('summary').click();
    await expect(token).toHaveCount(0);
    expect(fixture.runs).toEqual([]);
  } finally { late.resolve(); }
});
