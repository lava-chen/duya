// @vitest-environment jsdom
/**
 * workspace-lifecycle-ipc.test.ts — the renderer half of the
 * workspace-lifecycle port.
 *
 * The shared renderer runs on a host it did not choose: Electron provides
 * `window.electronAPI`, the browser does not. These cases pin the two
 * properties the port contract depends on:
 *
 *   1. A surface with no bridge answers with an EMPTY answer instead of
 *      taking the whole load down — and the empty answer is `null` ("this
 *      surface cannot answer"), never a fabricated "this session has no
 *      checkout".
 *   2. A surface WITH a bridge passes the Host's DTO through verbatim: an
 *      `unknown` integration observation stays `unknown`, and a reclaim
 *      refusal stays a refusal rather than becoming an error.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  HostCheckoutObserved,
  HostIntegrationRecord,
  HostIntegrationSyncResult,
  HostSessionCheckoutView,
} from '@duya/agent-protocol';
import {
  createElectronWorkspaceLifecyclePort,
  observeCheckout,
  observeCheckoutForSession,
  observeIntegrationsForSession,
  refreshIntegrationsForSession,
  requestCheckoutReclaim,
} from './workspace-lifecycle-ipc';

const SESSION_ID = 'session-1' as HostSessionCheckoutView['sessionId'];

function checkoutObserved(overrides: Partial<HostCheckoutObserved> = {}): HostCheckoutObserved {
  return {
    root: 'C:/repo/worktrees/session-1',
    cwd: 'C:/repo/worktrees/session-1',
    registered: true,
    worktree: 'clean',
    ownerSessionId: SESSION_ID,
    ownerUnreadable: false,
    locked: false,
    reclaimable: true,
    retainReason: null,
    observedAt: 1_700_000_000_000,
    ...overrides,
  };
}

function integrationRecord(overrides: Partial<HostIntegrationRecord> = {}): HostIntegrationRecord {
  return {
    repo: 'owner/repo',
    prNumber: 42,
    state: 'open',
    headSha: 'a'.repeat(40),
    baseRef: 'main',
    url: 'https://example.test/owner/repo/pull/42',
    observedAt: 1_700_000_000_000,
    observedError: null,
    ...overrides,
  };
}

/** Install a bridge whose answers the test controls. */
function installBridge(answers: {
  checkout?: HostSessionCheckoutView;
  observed?: HostCheckoutObserved;
  reclaim?: { removed: true } | { removed: false; reason: 'dirty_tracked' };
  records?: readonly HostIntegrationRecord[];
  refresh?: HostIntegrationSyncResult;
}) {
  const invoke = vi.fn(async (channel: string) => {
    switch (channel) {
      case 'workspace-lifecycle:checkout:observe-for-session':
        return answers.checkout;
      case 'workspace-lifecycle:checkout:observe':
        return answers.observed;
      case 'workspace-lifecycle:checkout:reclaim':
        return answers.reclaim;
      case 'workspace-lifecycle:integration:observe-for-session':
        return answers.records;
      case 'workspace-lifecycle:integration:refresh-for-session':
        return answers.refresh;
      default:
        throw new Error(`unexpected channel ${channel}`);
    }
  });
  window.electronAPI = {
    workspaceLifecycle: {
      checkouts: {
        observeForSession: (sessionId: string) => invoke('workspace-lifecycle:checkout:observe-for-session'),
        observeCheckout: (root: string) => invoke('workspace-lifecycle:checkout:observe'),
        requestReclaim: (root: string) => invoke('workspace-lifecycle:checkout:reclaim'),
      },
      integrations: {
        observeForSession: (sessionId: string) => invoke('workspace-lifecycle:integration:observe-for-session'),
        refreshForSession: (sessionId: string) => invoke('workspace-lifecycle:integration:refresh-for-session'),
      },
    },
  } as unknown as typeof window.electronAPI;
  return invoke;
}

/** Remove the bridge, as a browser surface has. */
function removeBridge(): void {
  window.electronAPI = undefined as unknown as typeof window.electronAPI;
}

afterEach(() => {
  removeBridge();
});

describe('workspace-lifecycle on a surface without the Electron bridge', () => {
  it('answers with an empty answer instead of throwing', async () => {
    await expect(observeCheckoutForSession(SESSION_ID)).resolves.toBeNull();
    await expect(observeCheckout('C:/repo/worktrees/session-1')).resolves.toBeNull();
    await expect(requestCheckoutReclaim('C:/repo/worktrees/session-1')).resolves.toBeNull();
    await expect(observeIntegrationsForSession(SESSION_ID)).resolves.toBeNull();
    await expect(refreshIntegrationsForSession(SESSION_ID)).resolves.toBeNull();
  });

  it('installs no namespace, so the panel can say the surface cannot answer', () => {
    const port = createElectronWorkspaceLifecyclePort();
    expect(port.checkouts).toBeUndefined();
    expect(port.integrations).toBeUndefined();
  });
});

describe('workspace-lifecycle through the Electron bridge', () => {
  it('installs both namespaces', () => {
    installBridge({});
    const port = createElectronWorkspaceLifecyclePort();
    expect(port.checkouts).toBeDefined();
    expect(port.integrations).toBeDefined();
  });

  it('passes the Host checkout observation through unchanged', async () => {
    const observed = checkoutObserved();
    installBridge({ observed });
    await expect(observeCheckout(observed.root)).resolves.toEqual(observed);
  });

  it('keeps an unknown integration observation unknown', async () => {
    const unknown = integrationRecord({ state: 'unknown', observedError: 'observer_unavailable' });
    installBridge({ records: [unknown] });
    const records = await observeIntegrationsForSession(SESSION_ID);
    expect(records?.[0]?.state).toBe('unknown');
    expect(records?.[0]?.observedError).toBe('observer_unavailable');
  });

  it('treats a reclaim refusal as a normal answer, not an error', async () => {
    installBridge({ reclaim: { removed: false, reason: 'dirty_tracked' } });
    const answer = await requestCheckoutReclaim('C:/repo/worktrees/session-1');
    expect(answer).toEqual({ removed: false, reason: 'dirty_tracked' });
  });

  it('reads the session checkout view through the port', async () => {
    const view: HostSessionCheckoutView = {
      sessionId: SESSION_ID,
      checkout: checkoutObserved(),
      isOwner: true,
    };
    installBridge({ checkout: view });
    const port = createElectronWorkspaceLifecyclePort();
    await expect(port.checkouts!.observeForSession(SESSION_ID)).resolves.toEqual(view);
  });

  it('reads the observed integrations through the port', async () => {
    const records = [integrationRecord()];
    installBridge({ records });
    const port = createElectronWorkspaceLifecyclePort();
    await expect(port.integrations!.observeForSession(SESSION_ID)).resolves.toEqual(records);
  });

  it('refreshes the session integrations through the port', async () => {
    const refresh: HostIntegrationSyncResult = {
      status: 'synced',
      written: [{ repo: 'owner/repo', prNumber: 42 }],
      failed: [],
    };
    installBridge({ refresh });
    const port = createElectronWorkspaceLifecyclePort();
    await expect(port.integrations!.refreshForSession(SESSION_ID)).resolves.toEqual(refresh);
  });
});
