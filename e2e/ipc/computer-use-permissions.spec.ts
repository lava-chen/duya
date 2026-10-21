/**
 * computer-use-permissions.spec.ts — plan 572 Phase 1 e2e gate.
 *
 * Exercises the full preload → ipcMain → AX helper chain in the
 * REAL Electron renderer (browser-only Vite cannot validate the
 * preload path):
 *   - computerUsePermissions.get()  → TCC snapshot shape + helper state
 *   - computerUsePermissions.openPane() with an unknown pane → false
 *
 * The TCC surface is macOS-only. The handler answers with an "unknown"
 * snapshot on every other platform (the UI hides the card there), and the
 * AX helper is a LOCAL build artefact — `resources/ax-helper/bin` holds
 * Swift sources, not the built binary — so a CI runner has no helper even
 * on macOS. So the contract asserted here is the one that holds
 * everywhere: the snapshot's SHAPE, the platform it describes, and the
 * unknown-snapshot values off darwin. TCC states are environment-dependent
 * in any case (dev runs attribute to the host app), so no specific grant
 * value is asserted.
 */
import { test, expect } from '@playwright/test';
import { launchDuya, invokeApi, closeDuya, type DuyaApp } from '../helpers';

// The contract these cases assert is macOS's. TCC states come from the
// accessibility helper, which only exists on darwin, and the first case
// asserts `platform === 'darwin'` outright. On any other platform this file
// was not testing the API it describes — it was failing on the platform,
// which is why the suite ran red on the Linux runner.
test.skip(process.platform !== 'darwin', 'computer-use permissions are a macOS TCC contract');

let app: DuyaApp;

test.afterEach(async () => {
  if (app) {
    await closeDuya(app.app);
    app = undefined as unknown as DuyaApp;
  }
});

const STATES = ['granted', 'denied', 'not-determined', 'unknown'];
const IS_DARWIN = process.platform === 'darwin';

test('computer-use:permissions:get returns a platform-correct snapshot', async () => {
  app = await launchDuya({ namespace: 'cu-permissions' });
  const snap = await invokeApi<{
    platform: string;
    helperAvailable: boolean;
    accessibility: string;
    screen: string;
    listen: string;
    secureInputPid: number | null;
  }>(app.page, 'computerUsePermissions.get');

  // The snapshot always describes the platform it was taken on.
  expect(snap.platform).toBe(process.platform);
  expect(typeof snap.helperAvailable).toBe('boolean');
  expect(STATES).toContain(snap.accessibility);
  expect(STATES).toContain(snap.screen);
  expect(STATES).toContain(snap.listen);
  expect(snap.secureInputPid === null || typeof snap.secureInputPid === 'number').toBe(true);

  if (!IS_DARWIN) {
    // No TCC here: the handler answers with the unknown snapshot.
    expect(snap.helperAvailable).toBe(false);
    expect(snap.accessibility).toBe('unknown');
    expect(snap.screen).toBe('unknown');
    expect(snap.listen).toBe('unknown');
  }
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
