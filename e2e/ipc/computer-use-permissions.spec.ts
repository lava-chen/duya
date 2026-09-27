/**
 * computer-use-permissions.spec.ts — plan 572 Phase 1 e2e gate.
 *
 * Exercises the full preload → ipcMain → AX helper binary chain in the
 * REAL Electron renderer (browser-only Vite cannot validate the
 * preload path):
 *   - computerUsePermissions.get()  → TCC snapshot shape + helper alive
 *   - computerUsePermissions.openPane() with an unknown pane → false
 *
 * TCC states are environment-dependent (dev runs attribute to the host
 * app), so the assertions cover the CONTRACT (field shapes, enum
 * domain, helperAvailable=true) rather than specific grant values.
 * The helper binary is the dev-repo build (resources/ax-helper/bin/).
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

const STATES = ['granted', 'denied', 'not-determined', 'unknown'];

test('computer-use:permissions:get returns a live TCC snapshot through the AX helper', async () => {
  app = await launchDuya({ namespace: 'cu-permissions' });
  const snap = await invokeApi<{
    platform: string;
    helperAvailable: boolean;
    accessibility: string;
    screen: string;
    listen: string;
    secureInputPid: number | null;
  }>(app.page, 'computerUsePermissions.get');

  expect(snap.platform).toBe('darwin');
  // The helper binary exists in the dev layout and answered.
  expect(snap.helperAvailable).toBe(true);
  expect(STATES).toContain(snap.accessibility);
  expect(STATES).toContain(snap.screen);
  expect(STATES).toContain(snap.listen);
  expect(snap.secureInputPid === null || typeof snap.secureInputPid === 'number').toBe(true);
});

test('computer-use:permissions:open refuses unknown panes', async () => {
  app = await launchDuya({ namespace: 'cu-permissions-open' });
  const ok = await invokeApi<boolean>(
    app.page,
    'computerUsePermissions.openPane',
    'not-a-pane',
  );
  expect(ok).toBe(false);
});
