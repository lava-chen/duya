/**
 * preload-workspace-lifecycle-bridge.test.ts — the preload half of the
 * workspace-lifecycle bridge (plan 621, slice F).
 *
 * The preload lives outside the vitest include globs, so its bridge is
 * exercised from the main side: the module is imported with `electron`
 * mocked, and the object it hands to `contextBridge.exposeInMainWorld` is
 * inspected.
 *
 * The property under test is narrow and load-bearing: the renderer reaches
 * the Host's checkout and integration observations through a bridge that
 * exists. A bridge that is missing, or a method that invokes no channel, is
 * the failure mode the repo has been bitten by before (plan 583 ISS-24:
 * channels exposed with no handler, every call rejecting).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  exposed: new Map<string, unknown>(),
  invoked: [] as { channel: string; args: unknown[] }[],
}));

vi.mock('electron', () => ({
  contextBridge: {
    exposeInMainWorld: (key: string, value: unknown) => {
      mocks.exposed.set(key, value);
    },
  },
  ipcRenderer: {
    invoke: (channel: string, ...args: unknown[]) => {
      mocks.invoked.push({ channel, args });
      return Promise.resolve(null);
    },
    on: () => undefined,
    send: () => undefined,
    removeListener: () => undefined,
  },
  webUtils: { getPathForFile: () => '' },
}));

import '../../preload/index';

interface BridgeShape {
  workspaceLifecycle?: {
    checkouts?: Record<string, (...args: unknown[]) => unknown>;
    integrations?: Record<string, (...args: unknown[]) => unknown>;
  };
}

function bridge(): BridgeShape {
  const api = mocks.exposed.get('electronAPI') as BridgeShape | undefined;
  if (!api) throw new Error('the preload did not expose electronAPI');
  return api;
}

beforeEach(() => {
  mocks.invoked.length = 0;
});

describe('the preload workspace-lifecycle bridge', () => {
  it('exposes the checkout and integration namespaces', () => {
    const api = bridge();
    expect(api.workspaceLifecycle?.checkouts).toBeDefined();
    expect(api.workspaceLifecycle?.integrations).toBeDefined();
  });

  it('invokes the checkout channels the main process registered', async () => {
    const checkouts = bridge().workspaceLifecycle?.checkouts;
    await checkouts?.observeForSession('session-1');
    await checkouts?.observeCheckout('C:/repo/worktrees/session-1');
    await checkouts?.requestReclaim('C:/repo/worktrees/session-1');
    expect(mocks.invoked.map((entry) => entry.channel)).toEqual([
      'workspace-lifecycle:checkout:observe-for-session',
      'workspace-lifecycle:checkout:observe',
      'workspace-lifecycle:checkout:reclaim',
    ]);
  });

  it('invokes the integration channels the main process registered', async () => {
    const integrations = bridge().workspaceLifecycle?.integrations;
    await integrations?.observeForSession('session-1');
    await integrations?.refreshForSession('session-1');
    expect(mocks.invoked.map((entry) => entry.channel)).toEqual([
      'workspace-lifecycle:integration:observe-for-session',
      'workspace-lifecycle:integration:refresh-for-session',
    ]);
    expect(mocks.invoked.at(-1)?.args).toEqual(['session-1']);
  });
});
