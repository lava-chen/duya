/**
 * ax-helper live integration test (plan 572).
 *
 * Unlike recorder-ax-helper.test.ts (FakeProcess), this drives the REAL
 * helper binary through the real spawn pipeline: ready gate, ping,
 * permissions contract, and fg. It skips silently when the binary has
 * not been built (scripts/build-ax-helper.sh) or on non-macOS — the
 * unit suites cover the protocol everywhere else.
 */

import { describe, expect, it, afterAll } from 'vitest';
import { existsSync } from 'node:fs';

import { AxHelperClient, resolveAxHelperPath } from '../recorder/ax-helper';

const binary = resolveAxHelperPath();
const liveReady = process.platform === 'darwin' && existsSync(binary);

const describeLive = liveReady ? describe : describe.skip;

describeLive('AxHelperClient (live helper binary)', () => {
  const client = new AxHelperClient({ helperPath: binary });
  afterAll(() => client.dispose());

  it('starts, answers ping via the request protocol, and reports the TCC contract', async () => {
    await client.ensureStarted();
    expect(client.currentState).toBe('running');

    const permissions = await client.permissions();
    expect(permissions).not.toBeNull();
    expect(['granted', 'denied', 'not-determined']).toContain(permissions!.accessibility);
    expect(['granted', 'denied', 'not-determined']).toContain(permissions!.screen);
    expect(['granted', 'denied', 'not-determined']).toContain(permissions!.listen);
    expect(permissions!.secureInputPid === null || typeof permissions!.secureInputPid === 'number').toBe(true);
  }, 15_000);

  it('returns a foreground snapshot or null (never throws)', async () => {
    const fg = await client.foreground();
    if (fg !== null) {
      expect(fg.pid).toBeGreaterThan(0);
      expect(typeof fg.processName).toBe('string');
      expect(fg.windowId).toBeGreaterThanOrEqual(0);
    }
  }, 10_000);

  it('surfaces permission-denied for AX reads while untrusted', async () => {
    const permissions = await client.permissions();
    // Only meaningful when the host process lacks the Accessibility grant.
    if (permissions && permissions.accessibility !== 'granted') {
      const code = await client.performAction(1, 'h-nonexistent', 'AXPress');
      // untrusted → permission-denied before the handle lookup; trusted
      // environments (manual runs) may see stale-handle instead.
      expect(['permission-denied', 'stale-handle']).toContain(code);
    }
  }, 10_000);
});
