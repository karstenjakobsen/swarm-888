import { expect, test, type Page } from '@playwright/test';
import type { Conversation, ConversationDetail, ExecutionEvent, Status } from '../web/types';

type StreamControl = {
  readonly readyState: number;
  event(value: ExecutionEvent): void;
  status(value: Status): void;
  disconnect(): void;
  reconnect(value: Status): void;
  keepAlive(value: Status): void;
};
type StreamWindow = Window & { workspaceStream: StreamControl };

async function settleRefreshes(page: Page) {
  await page.clock.runFor(1200);
  await page.waitForLoadState('networkidle');
  await page.clock.runFor(1200);
  await page.waitForLoadState('networkidle');
}

async function workspace(page: Page, historySize = 0, holdInitialStatus = false) {
  const now = new Date().toISOString();
  const conversation: Conversation = { id: 'sync_fixture_conversation', title: 'Current discussion', threadId: null, createdAt: now, updatedAt: now };
  const detail: ConversationDetail = {
    conversation,
    messages: [{ id: 'sync_initial_message', conversationId: conversation.id, runId: 'sync_fixture_run', role: 'assistant', content: 'The saved conversation is ready.', createdAt: now }],
    runs: [], events: [],
  };
  const state: Status = { worker: null, workerError: null, maintenance: false, queue: [] };
  const counts = { status: 0, conversations: 0, detail: 0 };
  let releaseStatus = () => {};
  const initialStatusGate = new Promise<void>(resolve => { releaseStatus = resolve; });
  const history: ExecutionEvent[] = Array.from({ length: historySize }, (_, index) => ({
    seq: index + 1, type: ['run', 'completed', 'thread', 'clarification'][index % 4]!,
    conversationId: conversation.id, runId: `historic_run_${index}`, data: {}, createdAt: now,
  }));
  await page.addInitScript(({ history, status }) => {
    class ControlledEventSource extends EventTarget {
      static CONNECTING = 0;
      static OPEN = 1;
      static CLOSED = 2;
      readonly CONNECTING = 0;
      readonly OPEN = 1;
      readonly CLOSED = 2;
      readyState = 0;
      onopen: ((event: Event) => void) | null = null;
      onerror: ((event: Event) => void) | null = null;
      heartbeat: ReturnType<typeof setInterval> | undefined;
      constructor(public url: string) {
        super();
        (window as unknown as StreamWindow).workspaceStream = this;
        queueMicrotask(() => {
          if (this.readyState === this.CLOSED) return;
          this.readyState = this.OPEN; this.onopen?.(new Event('open'));
          for (const event of history) this.event(event);
          this.status(status);
        });
      }
      event(value: ExecutionEvent) { this.dispatchEvent(new MessageEvent('event', { data: JSON.stringify(value) })); }
      status(value: Status) { this.dispatchEvent(new MessageEvent('status', { data: JSON.stringify(value) })); }
      disconnect() {
        clearInterval(this.heartbeat); this.readyState = this.CONNECTING;
        this.onerror?.(new Event('error'));
      }
      reconnect(value: Status) {
        this.readyState = this.OPEN; this.onopen?.(new Event('open')); this.status(value);
      }
      keepAlive(value: Status) { clearInterval(this.heartbeat); this.heartbeat = setInterval(() => this.status(value), 1500); }
      close() { this.readyState = this.CLOSED; clearInterval(this.heartbeat); }
    }
    window.EventSource = ControlledEventSource as unknown as typeof EventSource;
  }, { history, status: state });
  await page.route('**/api/status', async route => {
    counts.status++;
    const response = structuredClone(state);
    if (holdInitialStatus && counts.status === 1) await initialStatusGate;
    return route.fulfill({ json: response });
  });
  await page.route('**/api/conversations', route => { counts.conversations++; return route.fulfill({ json: [conversation] }); });
  await page.route(`**/api/conversations/${conversation.id}`, route => { counts.detail++; return route.fulfill({ json: detail }); });
  await page.route('**/api/connectors', route => route.fulfill({ json: [] }));
  await page.goto('/');
  await page.getByLabel('Administrator password').fill('browser-test-password-only');
  await page.getByRole('button', { name: 'Enter workspace' }).click();
  await expect(page.getByRole('heading', { name: conversation.title, exact: true })).toBeVisible();
  await expect(page.getByTestId('message-assistant')).toContainText('The saved conversation is ready.');
  await expect(page.locator('.connection-label')).toHaveText('Live');
  return { conversation, detail, state, counts, now, releaseStatus, nextSequence: historySize + 1 };
}

test('login replay reconciles the workspace once rather than refetching for every historical event', async ({ page }) => {
  await page.clock.install();
  const fixture = await workspace(page, 160);
  await settleRefreshes(page);
  await expect(page.locator('.conversation-link.selected')).toContainText(fixture.conversation.title);
  expect(fixture.counts.status).toBeLessThanOrEqual(1);
  expect(fixture.counts.conversations).toBeLessThanOrEqual(2);
  expect(fixture.counts.detail).toBeLessThanOrEqual(2);

  const before = { ...fixture.counts };
  fixture.state.maintenance = true;
  await page.evaluate(state => (window as unknown as StreamWindow).workspaceStream.keepAlive(state), fixture.state);
  await page.clock.runFor(20_000);
  await expect(page.getByText('Maintenance is active.', { exact: false })).toBeVisible();
  expect(fixture.counts.status).toBe(before.status);
  expect(fixture.counts.conversations).toBe(before.conversations);
  expect(fixture.counts.detail).toBe(before.detail);
});

test('a live event burst refreshes current conversation data in one batch without status refetches', async ({ page }) => {
  await page.clock.install();
  const fixture = await workspace(page);
  await settleRefreshes(page);
  const before = { ...fixture.counts };
  fixture.conversation.title = 'Updated during the live run';
  fixture.detail.messages.push({ id: 'sync_completed_message', conversationId: fixture.conversation.id, runId: 'sync_live_run', role: 'assistant', content: 'The live task has completed.', createdAt: fixture.now });
  const events: ExecutionEvent[] = Array.from({ length: 80 }, (_, index) => ({
    seq: fixture.nextSequence + index, type: ['run', 'completed', 'thread', 'clarification'][index % 4]!,
    conversationId: fixture.conversation.id, runId: 'sync_live_run', data: {}, createdAt: fixture.now,
  }));
  await page.evaluate(events => { for (const event of events) (window as unknown as StreamWindow).workspaceStream.event(event); }, events);
  await page.clock.runFor(1200);
  await expect(page.getByRole('heading', { name: fixture.conversation.title, exact: true })).toBeVisible();
  await expect(page.getByTestId('message-assistant').last()).toContainText('The live task has completed.');
  expect(fixture.counts.status).toBe(before.status);
  expect(fixture.counts.conversations - before.conversations).toBe(1);
  expect(fixture.counts.detail - before.detail).toBe(1);
});

test('stale and disconnected streams use fallback status and reconcile once when the stream recovers', async ({ page }) => {
  await page.clock.install();
  const fixture = await workspace(page);
  await settleRefreshes(page);
  const initialStatusReads = fixture.counts.status;
  fixture.state.maintenance = true;
  await page.clock.runFor(35_000);
  await expect(page.getByText('Maintenance is active.', { exact: false })).toBeVisible();
  expect(fixture.counts.status).toBeGreaterThan(initialStatusReads);

  await page.evaluate(() => (window as unknown as StreamWindow).workspaceStream.disconnect());
  await expect(page.locator('.connection-label')).toHaveText('Reconnecting');
  const disconnectedStatusReads = fixture.counts.status;
  fixture.state.maintenance = false;
  await page.clock.runFor(6000);
  await expect(page.getByText('Maintenance is active.', { exact: false })).toHaveCount(0);
  expect(fixture.counts.status).toBeGreaterThan(disconnectedStatusReads);

  fixture.conversation.title = 'Recovered remote discussion';
  fixture.detail.messages.push({ id: 'sync_recovered_message', conversationId: fixture.conversation.id, runId: 'sync_recovered_run', role: 'assistant', content: 'This message arrived while the stream was disconnected.', createdAt: fixture.now });
  const beforeReconnect = { ...fixture.counts };
  await page.evaluate(state => {
    const stream = (window as unknown as StreamWindow).workspaceStream;
    stream.reconnect(state); stream.keepAlive(state);
  }, fixture.state);
  await page.clock.runFor(1200);
  await expect(page.locator('.connection-label')).toHaveText('Live');
  await expect(page.getByRole('heading', { name: fixture.conversation.title, exact: true })).toBeVisible();
  await expect(page.getByTestId('message-assistant').last()).toContainText('This message arrived while the stream was disconnected.');
  expect(fixture.counts.conversations - beforeReconnect.conversations).toBe(1);
  expect(fixture.counts.detail - beforeReconnect.detail).toBe(1);
  const recoveredStatusReads = fixture.counts.status;
  await page.clock.runFor(15_000);
  expect(fixture.counts.status).toBe(recoveredStatusReads);
});

test('a delayed REST status response cannot overwrite a newer stream snapshot', async ({ page }) => {
  await page.clock.install();
  const fixture = await workspace(page, 0, true);
  try {
    await expect.poll(() => fixture.counts.status).toBe(1);
    fixture.state.maintenance = true;
    await page.evaluate(state => (window as unknown as StreamWindow).workspaceStream.status(state), fixture.state);
    await expect(page.getByText('Maintenance is active.', { exact: false })).toBeVisible();

    fixture.releaseStatus();
    await settleRefreshes(page);
    await expect(page.getByText('Maintenance is active.', { exact: false })).toBeVisible();
    expect(fixture.counts.status).toBe(1);
  } finally { fixture.releaseStatus(); }
});

test('logout closes the stream and cancels pending event refreshes and fallback polling', async ({ page }) => {
  await page.clock.install();
  const fixture = await workspace(page);
  await settleRefreshes(page);
  await page.clock.pauseAt(await page.evaluate(() => Date.now() + 1000));
  const beforeLogout = { ...fixture.counts };
  const event: ExecutionEvent = { seq: fixture.nextSequence, type: 'thread', runId: 'sync_logout_run', conversationId: fixture.conversation.id, data: {}, createdAt: fixture.now };
  await page.evaluate(event => (window as unknown as StreamWindow).workspaceStream.event(event), event);
  await page.locator('.logout').click();
  await expect(page.getByLabel('Administrator password')).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as StreamWindow).workspaceStream.readyState)).toBe(2);

  await page.clock.runFor(35_000);
  await page.waitForLoadState('networkidle');
  expect(fixture.counts).toEqual(beforeLogout);
  await expect(page.getByLabel('Administrator password')).toBeVisible();
});

test('a delayed conversation snapshot preserves messages that already arrived on the live stream', async ({ page }) => {
  await page.clock.install();
  const fixture = await workspace(page);
  await settleRefreshes(page);
  let release = () => {}, started = () => {};
  const responseGate = new Promise<void>(resolve => { release = resolve; });
  const requestStarted = new Promise<void>(resolve => { started = resolve; });
  await page.route(`**/api/conversations/${fixture.conversation.id}`, async route => {
    const snapshot = structuredClone(fixture.detail);
    started(); await responseGate;
    return route.fulfill({ json: snapshot });
  });
  try {
    const event: ExecutionEvent = { seq: fixture.nextSequence, type: 'thread', runId: 'sync_late_snapshot', conversationId: fixture.conversation.id, data: {}, createdAt: fixture.now };
    await page.evaluate(event => (window as unknown as StreamWindow).workspaceStream.event(event), event);
    await page.clock.runFor(200); await requestStarted;
    const message = { id: 'sync_streamed_message', conversationId: fixture.conversation.id, runId: 'sync_late_snapshot', role: 'assistant' as const, content: 'This new answer arrived after the HTTP snapshot.', createdAt: fixture.now };
    await page.evaluate(event => (window as unknown as StreamWindow).workspaceStream.event(event), { ...event, seq: event.seq + 1, type: 'message', data: { message } });
    await expect(page.getByTestId('message-assistant').last()).toContainText(message.content);
    release(); await settleRefreshes(page);
    await expect(page.getByTestId('message-assistant').last()).toContainText(message.content);
  } finally { release(); }
});

test('an expired request from an earlier session cannot log out a newly authenticated session', async ({ page }) => {
  await page.clock.install();
  await workspace(page); await settleRefreshes(page);
  let release = () => {}, started = () => {};
  const responseGate = new Promise<void>(resolve => { release = resolve; });
  const requestStarted = new Promise<void>(resolve => { started = resolve; });
  let requests = 0;
  await page.route('**/api/skills', async route => {
    if (++requests > 1) return route.fulfill({ json: [] });
    started(); await responseGate;
    return route.fulfill({ status: 401, json: { error: 'Previous session expired' } });
  });
  try {
    await page.getByRole('button', { name: 'Skills', exact: true }).click(); await requestStarted;
    await page.locator('.logout').click();
    await page.getByLabel('Administrator password').fill('browser-test-password-only');
    await page.getByRole('button', { name: 'Enter workspace' }).click();
    await expect(page.locator('.logout')).toBeVisible();
    release(); await settleRefreshes(page);
    await expect(page.locator('.logout')).toBeVisible();
    await expect(page.getByLabel('Administrator password')).toHaveCount(0);
  } finally { release(); }
});
