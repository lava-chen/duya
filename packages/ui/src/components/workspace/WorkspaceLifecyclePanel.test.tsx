// @vitest-environment jsdom
/**
 * The shared workspace-lifecycle panel (plan 621, slice F).
 *
 * The panel is the one place where the three surfaces meet, so the tests are
 * about the distinctions the contract (§4.3) insists on:
 *
 *   - "not in a checkout" is not "this surface cannot observe checkouts";
 *   - an observation never decides whether a checkout may be deleted — the
 *     Host does, at the moment of the action;
 *   - a pull request whose observation failed is `unknown`, never `open`;
 *   - reading never refreshes; refreshing is an explicit act.
 *
 * The tests read the i18n KEYS, because the dictionary is not what is being
 * tested here — the wiring is.
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, render, screen, fireEvent, waitFor } from '@testing-library/react';
import { WorkspaceLifecyclePanel } from './WorkspaceLifecyclePanel';
import type { PartialWorkspaceLifecyclePort } from '@/services/workspace-lifecycle';
import type {
  HostCheckoutObserved,
  HostIntegrationRecord,
  HostSessionCheckoutView,
  SessionId,
} from '@duya/agent-protocol';

vi.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, unknown>) =>
      params ? `${key} ${Object.values(params).join(' ')}` : key,
  }),
}));

const portState = vi.hoisted(() => ({ current: null as PartialWorkspaceLifecyclePort | null }));

vi.mock('@/hooks/useWorkspaceLifecycle', () => ({
  useWorkspaceLifecycle: () => portState.current,
}));

const SESSION = 'session-1' as SessionId;

function observed(overrides: Partial<HostCheckoutObserved> = {}): HostCheckoutObserved {
  return {
    root: '/repo/.claude/worktrees/task-1',
    cwd: '/repo/.claude/worktrees/task-1/packages/host',
    registered: true,
    worktree: 'clean',
    ownerSessionId: SESSION,
    ownerUnreadable: false,
    locked: false,
    reclaimable: true,
    retainReason: null,
    observedAt: 1_700_000_000_000,
    ...overrides,
  };
}

function view(checkout: HostCheckoutObserved | null): HostSessionCheckoutView {
  return {
    sessionId: SESSION,
    checkout,
    isOwner: checkout !== null && checkout.ownerSessionId === SESSION,
  };
}

function record(overrides: Partial<HostIntegrationRecord> = {}): HostIntegrationRecord {
  return {
    repo: 'duya/duya',
    prNumber: 21,
    state: 'open',
    headSha: 'abc',
    baseRef: 'main',
    url: 'https://github.com/duya/duya/pull/21',
    observedAt: 1_700_000_000_000,
    observedError: null,
    ...overrides,
  };
}

beforeEach(() => {
  portState.current = null;
  vi.clearAllMocks();
});

// Without cleanup the rendered panels pile up in the document, and every
// `getByText` then finds the previous test's DOM as well.
afterEach(cleanup);

describe('the surface that cannot answer', () => {
  it('says so for both namespaces instead of showing an empty checkout', async () => {
    portState.current = null;
    render(<WorkspaceLifecyclePanel sessionId={SESSION} />);

    await waitFor(() => {
      expect(screen.getByText('wsl.checkout.cannotAnswer')).toBeTruthy();
    });
    expect(screen.getByText('wsl.integrations.cannotAnswer')).toBeTruthy();
    // The dangerous shape: an empty checkout the user then acts on.
    expect(screen.queryByText('wsl.checkout.none')).toBeNull();
  });

  it('says the checkout namespace is unreachable while integrations still answer', async () => {
    portState.current = {
      integrations: {
        observeForSession: async () => [record()],
        refreshForSession: async () => ({ status: 'synced', written: [], failed: [] }),
      },
    };
    render(<WorkspaceLifecyclePanel sessionId={SESSION} />);

    await waitFor(() => {
      expect(screen.getByText('wsl.checkout.cannotAnswer')).toBeTruthy();
    });
    expect(screen.queryByText('wsl.checkout.none')).toBeNull();
    expect(await screen.findByText('duya/duya#21')).toBeTruthy();
  });
});

describe('the checkout facts', () => {
  it('reports a session that is not inside a managed checkout', async () => {
    portState.current = {
      checkouts: {
        observeForSession: async () => view(null),
        observeCheckout: async () => observed(),
        requestReclaim: async () => ({ removed: false, reason: 'not_registered' as const }),
      },
    };
    render(<WorkspaceLifecyclePanel sessionId={SESSION} />);

    expect(await screen.findByText('wsl.checkout.none')).toBeTruthy();
    expect(screen.queryByText('wsl.checkout.cannotAnswer')).toBeNull();
  });

  it('shows the path, the owner and the moment the observation was taken', async () => {
    portState.current = {
      checkouts: {
        observeForSession: async () => view(observed()),
        observeCheckout: async () => observed(),
        requestReclaim: async () => ({ removed: false, reason: 'not_registered' as const }),
      },
    };
    render(<WorkspaceLifecyclePanel sessionId={SESSION} />);

    expect(await screen.findByText('/repo/.claude/worktrees/task-1')).toBeTruthy();
    expect(screen.getByText('wsl.checkout.ownerSelf')).toBeTruthy();
    expect(screen.getByText('2023-11-14 22:13:20 UTC')).toBeTruthy();
  });

  it('reports an unreadable owner as unknown, not as unowned', async () => {
    portState.current = {
      checkouts: {
        observeForSession: async () =>
          view(observed({ ownerSessionId: null, ownerUnreadable: true })),
        observeCheckout: async () => observed(),
        requestReclaim: async () => ({ removed: false, reason: 'not_registered' as const }),
      },
    };
    render(<WorkspaceLifecyclePanel sessionId={SESSION} />);

    expect(await screen.findByText('wsl.checkout.ownerUnknown')).toBeTruthy();
    expect(screen.queryByText('wsl.checkout.ownerNone')).toBeNull();
  });
});

describe('the pull requests', () => {
  it('renders an unknown observation as unknown, with its reason', async () => {
    portState.current = {
      integrations: {
        observeForSession: async () => [
          record({ state: 'unknown', observedError: 'gh: not authenticated' }),
        ],
        refreshForSession: async () => ({ status: 'observation_failed', written: [], failed: [] }),
      },
    };
    render(<WorkspaceLifecyclePanel sessionId={SESSION} />);

    expect(await screen.findByText('unknown')).toBeTruthy();
    expect(screen.getByText('wsl.integrations.unknown gh: not authenticated')).toBeTruthy();
    // "We could not look" is not "the pull request is open".
    expect(screen.queryByText('open')).toBeNull();
  });

  it('never refreshes on a plain read', async () => {
    const refreshForSession = vi.fn(async () => ({
      status: 'synced' as const,
      written: [],
      failed: [],
    }));
    portState.current = {
      integrations: {
        observeForSession: async () => [record()],
        refreshForSession,
      },
    };
    render(<WorkspaceLifecyclePanel sessionId={SESSION} />);

    expect(await screen.findByText('duya/duya#21')).toBeTruthy();
    expect(refreshForSession).not.toHaveBeenCalled();
  });

  it('refreshes through the Host when the user asks for it', async () => {
    const refreshForSession = vi.fn(async () => ({
      status: 'synced' as const,
      written: [{ repo: 'duya/duya', prNumber: 21 }],
      failed: [],
    }));
    const observeForSession = vi.fn(async () => [record()]);
    portState.current = {
      integrations: {
        observeForSession,
        refreshForSession,
      },
    };
    render(<WorkspaceLifecyclePanel sessionId={SESSION} />);

    await screen.findByText('duya/duya#21');
    fireEvent.click(screen.getByText('wsl.integrations.refresh'));

    await waitFor(() => {
      expect(refreshForSession).toHaveBeenCalledWith(SESSION);
    });
    // The refresh is followed by a fresh read — the panel never renders the
    // refresh result as if it were the projection.
    await waitFor(() => {
      expect(observeForSession.mock.calls.length).toBeGreaterThan(1);
    });
    expect(await screen.findByText('wsl.integrations.refreshed synced')).toBeTruthy();
  });
});

describe('reclaiming', () => {
  it('asks the Host even when the observation says the checkout is not reclaimable', async () => {
    const requestReclaim = vi.fn(async () => ({ removed: false, reason: 'dirty_tracked' as const }));
    portState.current = {
      checkouts: {
        observeForSession: async () =>
          view(observed({ reclaimable: false, retainReason: 'dirty_tracked' })),
        observeCheckout: async () => observed(),
        requestReclaim,
      },
    };
    render(<WorkspaceLifecyclePanel sessionId={SESSION} />);

    expect(await screen.findByText('wsl.checkout.retained dirty_tracked')).toBeTruthy();
    // The observed verdict is information, not a permission: the button is
    // there, and the Host decides.
    fireEvent.click(screen.getByText('wsl.checkout.reclaimAction'));
    await waitFor(() => {
      expect(requestReclaim).toHaveBeenCalledWith('/repo/.claude/worktrees/task-1');
    });
  });

  it('shows a refusal as the Host\'s answer, not as a failure', async () => {
    portState.current = {
      checkouts: {
        observeForSession: async () => view(observed({ reclaimable: false, retainReason: 'dirty_tracked' })),
        observeCheckout: async () => observed(),
        requestReclaim: async () => ({ removed: false, reason: 'dirty_tracked' as const }),
      },
    };
    render(<WorkspaceLifecyclePanel sessionId={SESSION} />);

    await screen.findByText('wsl.checkout.retained dirty_tracked');
    fireEvent.click(screen.getByText('wsl.checkout.reclaimAction'));

    expect(await screen.findByText('wsl.checkout.reclaimRefused dirty_tracked')).toBeTruthy();
  });
});
