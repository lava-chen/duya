/**
 * system.spec.ts — E2E for security-critical system IPC handlers.
 *
 * Drives the real Electron binary so ipcMain.handle roundtrips go through
 * the actual Main process (not a vitest mock). Channels covered:
 *   - shell:open-external  → URL safety gate (4 rejections + happy path)
 *   - shell:open-path      → filesystem path gate
 *   - app:get-version      → passthrough
 *   - app:create-project-folder → sanitization + filesystem creation
 *   - system:get-location  → locale/timezone passthrough
 *
 * shell:open-external is the highest-leverage security channel: a
 * compromised renderer that could coax the OS into opening file:// or
 * javascript: URLs would be a sandbox escape. We assert the rejection
 * string for each blocked scheme so a future regression that silently
 * allows a scheme is caught.
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

// ---------------------------------------------------------------------------
// shell:open-external — URL safety gate
// ---------------------------------------------------------------------------

test('shell:open-external rejects file:// scheme', async () => {
  app = await launchDuya({ namespace: 'sys-open-file' });
  const result = await invokeApi<string>(app.page, 'shell.openExternal', 'file:///etc/passwd');
  expect(result).toContain('Blocked');
});

test('shell:open-external rejects javascript: scheme', async () => {
  app = await launchDuya({ namespace: 'sys-open-js' });
  const result = await invokeApi<string>(
    app.page,
    'shell.openExternal',
    'javascript:alert(1)',
  );
  expect(result).toContain('Blocked');
});

test('shell:open-external rejects smb:// scheme', async () => {
  app = await launchDuya({ namespace: 'sys-open-smb' });
  const result = await invokeApi<string>(
    app.page,
    'shell.openExternal',
    'smb://attacker/share',
  );
  expect(result).toContain('Blocked');
});

test('shell:open-external rejects empty input', async () => {
  app = await launchDuya({ namespace: 'sys-open-empty' });
  const result = await invokeApi<string>(app.page, 'shell.openExternal', '');
  expect(result).toContain('Invalid URL');
});

test('shell:open-external accepts https:// URL (returns empty string on success)', async () => {
  app = await launchDuya({ namespace: 'sys-open-https' });
  const result = await invokeApi<string>(
    app.page,
    'shell.openExternal',
    'https://example.com',
  );
  // On success, handler returns '' (empty string). On failure (e.g. no
  // default browser configured), it returns the error string. We accept
  // either — the security gate is what we're testing, not the OS browser.
  expect(result).not.toContain('Blocked');
  expect(result).not.toContain('Invalid URL');
});

// ---------------------------------------------------------------------------
// shell:open-path
// ---------------------------------------------------------------------------

test('shell:open-path rejects empty path', async () => {
  app = await launchDuya({ namespace: 'sys-path-empty' });
  const result = await invokeApi<string>(app.page, 'shell.openPath', '');
  expect(result).toBe('Invalid path');
});

// NOTE: NUL-character rejection is tested at the unit level
// (electron/ipc/__tests__/url-safety.test.ts) because NUL bytes do not
// survive Electron IPC serialization reliably — they can hang the IPC
// channel, making the E2E test flaky.

// ---------------------------------------------------------------------------
// app:* handlers
// ---------------------------------------------------------------------------

test('app.getVersion returns non-empty string', async () => {
  app = await launchDuya({ namespace: 'sys-version' });
  const version = await invokeApi<string>(app.page, 'app.getVersion');
  expect(typeof version).toBe('string');
  expect(version.length).toBeGreaterThan(0);
});

test('app.create-project-folder rejects empty name', async () => {
  app = await launchDuya({ namespace: 'sys-project-empty' });
  const result = await invokeApi<{ success: boolean; error: string; path: string }>(
    app.page,
    'app.createProjectFolder',
    '',
  );
  expect(result.success).toBe(false);
  expect(result.error).toContain('Invalid');
});

test('app.create-project-folder creates a real folder', async () => {
  app = await launchDuya({ namespace: 'sys-project-create' });
  const result = await invokeApi<{ success: boolean; error: string; path: string }>(
    app.page,
    'app.createProjectFolder',
    `e2e-test-${Date.now()}`,
  );
  expect(result.success).toBe(true);
  expect(result.path).toBeTruthy();
});

// ---------------------------------------------------------------------------
// system:get-location
// ---------------------------------------------------------------------------

test('system.getLocation returns locale and timezone', async () => {
  app = await launchDuya({ namespace: 'sys-location' });
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
