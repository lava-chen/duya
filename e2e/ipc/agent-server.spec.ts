/**
 * agent-server.spec.ts — E2E for Agent Server IPC handlers.
 *
 * Channels covered:
 *   - agent-server:getPort → returns the loopback port the Agent Server
 *     is listening on (or null if not yet started)
 *   - agent-server:getUrl  → returns http://127.0.0.1:<port> or null
 *
 * The Agent Server is spawned during Main boot. Under DUYA_TEST=1 it
 * still starts, so getPort should return a positive number once boot
 * completes. We poll for up to 30s to avoid racing the boot sequence.
 *
 * NOTE: Both assertions run inside a single test with a single Electron
 * launch. Launching two Electron instances back-to-back (one per test)
 * causes the second launch to time out on resource/port contention —
 * the Agent Server port from the first process may still be bound when
 * the second process starts.
 */
import { test, expect } from '@playwright/test';
import { launchDuya, invokeApi, closeDuya, type DuyaApp } from '../helpers';

let app: DuyaApp;

test.afterEach(async () => {
  if (app) {
    await closeDuya(app.app);
    app = undefined as unknown as DuyaApp;
  }
});

/**
 * Poll agent-server:getPort until it returns a positive number or timeout.
 * The Agent Server is forked asynchronously during boot; on slower CI
 * machines it may not be ready when the renderer first loads.
 */
async function waitForAgentServerPort(page: import('@playwright/test').Page): Promise<number> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const port = await invokeApi<number | null>(page, 'agentServer.getPort');
    if (typeof port === 'number' && port > 0) {
      return port;
    }
    await page.waitForTimeout(500);
  }
  throw new Error('Agent Server port never became available within 30s');
}

test('agent-server:getPort and getUrl return valid values after boot', async () => {
  app = await launchDuya({ namespace: 'agent-server-info' });
  const port = await waitForAgentServerPort(app.page);

  // getPort should return a valid port number
  expect(typeof port).toBe('number');
  expect(port).toBeGreaterThan(0);
  expect(port).toBeLessThan(65536);

  // getUrl should return the http://127.0.0.1:<port> form
  const url = await invokeApi<string | null>(app.page, 'agentServer.getUrl');
  expect(typeof url).toBe('string');
  expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  expect(url).toBe(`http://127.0.0.1:${port}`);
});
