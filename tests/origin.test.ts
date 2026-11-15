import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseEnv } from 'node:util';
import { loadConfig } from '../src/config.ts';
import { createController } from '../src/controller.ts';

test('the shipped development environment permits both loopback login URLs without weakening origin or CSRF checks', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'operator-loopback-origin-'));
  const previous = process.env;
  let close: (() => Promise<void>) | undefined;
  try {
    // Exercise exactly the origin settings users receive from the setup instructions.
    // Do not inherit APP_ORIGIN(S) or credentials from the caller's environment.
    process.env = {
      ...Object.fromEntries(Object.entries(previous).filter(([key]) => !/^(APP_|CODEX_|ADMIN_PASSWORD$)/.test(key))),
      ...parseEnv(readFileSync(new URL('../.env.example', import.meta.url), 'utf8')),
      APP_STATE_DIR: stateDir,
      APP_ALLOW_TEMP_STATE: 'true',
      ADMIN_PASSWORD: 'loopback-regression-password-only',
    };
    const config = loadConfig({ requireAdmin: true });
    process.env = previous;
    const controller = await createController(config, { startQueue: false, startBridge: false });
    close = controller.close;

    for (const origin of ['http://localhost:5173', 'http://127.0.0.1:5173']) {
      const login = await controller.app.inject({
        method: 'POST', url: '/api/login', headers: { origin },
        payload: { password: config.adminPassword },
      });
      assert.equal(login.statusCode, 200, `${origin} must permit administrator login`);
      const cookieHeader = String(login.headers['set-cookie']);
      assert.match(cookieHeader, /HttpOnly; SameSite=Strict/);
      const cookie = cookieHeader.split(';')[0]!;
      const csrf = login.json().csrfToken;
      const session = await controller.app.inject({
        method: 'GET', url: '/api/session', headers: { origin, cookie },
      });
      assert.equal(session.statusCode, 200);
      assert.equal(session.json().authenticated, true);
      assert.equal(session.json().csrfToken, csrf);

      const withoutCsrf = await controller.app.inject({
        method: 'POST', url: '/api/conversations', headers: { origin, cookie }, payload: {},
      });
      assert.equal(withoutCsrf.statusCode, 403);
      const conversation = await controller.app.inject({
        method: 'POST', url: '/api/conversations',
        headers: { origin, cookie, 'x-csrf-token': csrf },
        payload: { title: `Loopback login through ${new URL(origin).hostname}` },
      });
      assert.equal(conversation.statusCode, 200);
      assert.equal(typeof conversation.json().id, 'string');
    }

    for (const origin of ['http://localhost:5174', 'http://127.0.0.1:3001', 'http://unlisted.example:5173']) {
      const denied = await controller.app.inject({
        method: 'POST', url: '/api/login', headers: { origin },
        payload: { password: config.adminPassword },
      });
      assert.equal(denied.statusCode, 403, `${origin} must remain outside the allowlist`);
      assert.equal(denied.json().error, 'Origin is not permitted');
    }
    const missingOrigin = await controller.app.inject({
      method: 'POST', url: '/api/login', payload: { password: config.adminPassword },
    });
    assert.equal(missingOrigin.statusCode, 403);
    assert.equal(missingOrigin.json().error, 'A configured Origin is required');
  } finally {
    process.env = previous;
    if (close) await close();
    rmSync(stateDir, { recursive: true, force: true });
  }
});
