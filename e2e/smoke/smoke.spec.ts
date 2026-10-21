/**
 * Smoke test — verifies the Electron app boots, exposes electronAPI, and
 * answers basic info queries. This is the "canary" spec: if it fails, the
 * entire e2e suite is suspect.
 *
 * Drives the real Electron binary via Playwright `_electron` with
 * DUYA_TEST=1 and a per-spec --duya-namespace so userData/SQLite is fresh.
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

test('first window opens and reaches domcontentloaded', async () => {
  app = await launchDuya({ namespace: 'smoke-window' });
  const page = app.page;
  await expect(page).toHaveTitle(/.+/); // any non-empty title
});

test('window.electronAPI is exposed by preload contextBridge', async () => {
  app = await launchDuya({ namespace: 'smoke-api' });
  const hasApi = await app.page.evaluate(() =>
    typeof (window as unknown as { electronAPI?: unknown }).electronAPI !== 'undefined',
  );
  expect(hasApi).toBe(true);
});

test('app.getVersion returns a non-empty string', async () => {
  app = await launchDuya({ namespace: 'smoke-version' });
  const version = await invokeApi<string>(app.page, 'app.getVersion');
  expect(typeof version).toBe('string');
  expect(version.length).toBeGreaterThan(0);
});

test('system.getLocation returns locale and timezone', async () => {
  app = await launchDuya({ namespace: 'smoke-location' });
  const loc = await invokeApi<{
    locale: string;
    localeCountryCode: string | null;
    timezone: string;
  }>(app.page, 'system.getLocation');
  expect(typeof loc.locale).toBe('string');
  expect(loc.locale.length).toBeGreaterThan(0);
  expect(typeof loc.timezone).toBe('string');
  expect(loc.timezone.length).toBeGreaterThan(0);
});

test('electronAPI.versions exposes electron/node/chrome/platform', async () => {
  app = await launchDuya({ namespace: 'smoke-versions' });
  const versions = await app.page.evaluate(() => {
    const api = (window as unknown as { electronAPI: { versions: unknown } }).electronAPI;
    return api.versions;
  });
  expect(versions).toHaveProperty('electron');
  expect(versions).toHaveProperty('node');
  expect(versions).toHaveProperty('chrome');
  expect(versions).toHaveProperty('platform');
});

test('settingsDb.get on a non-existent key returns null (not throw)', async () => {
  app = await launchDuya({ namespace: 'smoke-settings-null' });
  const value = await invokeApi(app.page, 'settingsDb.get', 'smoke-nonexistent-key');
  expect(value).toBeNull();
});
