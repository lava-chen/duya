/**
 * workspace-lifecycle-handlers.test.ts — the main-process half of the
 * workspace-lifecycle bridge (plan 621, slice F).
 *
 * These cases pin the two rules the handlers must not bend:
 *
 *   - The Host's DTO is returned VERBATIM. An integration observation that
 *     says `unknown` stays `unknown`; a checkout observation is not trimmed,
 *     renamed or re-derived.
 *   - A reclaim refusal (`removed: false`) is a NORMAL answer. It is the
 *     Host's verdict on "may this be deleted", nothing was deleted, and the
 *     renderer must be able to show the reason.
 *
 * The Host client is mocked: what is under test here is the handler's
 * contract with the renderer, not the transport to the Host.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  HostCheckoutObserved,
  HostIntegrationRecord,
  HostIntegrationSyncResult,
  HostSessionCheckoutView,
} from '@duya/agent-protocol';

const mocks = vi.hoisted(() => {
  const handle = new Map<
    string,
    (event: unknown, ...args: unknown[]) => unknown | Promise<unknown>
  >();
  return {
    captured: { handle },
    api: {
      controlSessionCheckout: vi.fn(async (sessionId: string, command: unknown) => ({
        state: { version: 1, revision: 1, cwd: `C:/repo/worktrees/${sessionId}`, checkout: null, pending: null },
        outcome: 'status',
        command,
      })),
      observeCheckoutForSession: vi.fn(async (sessionId: string): Promise<HostSessionCheckoutView> => ({
        sessionId,
        checkout: null,
        isOwner: false,
      })),
      observeCheckoutByRoot: vi.fn(async (root: string): Promise<HostCheckoutObserved> => ({
        root,
        cwd: root,
        registered: true,
        worktree: 'clean',
        ownerSessionId: null,
        ownerUnreadable: false,
        locked: false,
        reclaimable: true,
        retainReason: null,
        observedAt: 1,
      })),
      requestCheckoutReclaim: vi.fn(
        async (): Promise<{ removed: true } | { removed: false; reason: 'dirty_tracked' }> => ({
          removed: false,
          reason: 'dirty_tracked',
        }),
      ),
      observeIntegrationsForSession: vi.fn(
        async (): Promise<readonly HostIntegrationRecord[]> => [
          {
            repo: 'owner/repo',
            prNumber: 42,
            state: 'unknown',
            headSha: null,
            baseRef: null,
            url: null,
            observedAt: 1,
            observedError: 'observer_unavailable',
          },
        ],
      ),
      syncIntegrations: vi.fn(async (): Promise<HostIntegrationSyncResult> => ({
        status: 'synced',
        written: [{ repo: 'owner/repo', prNumber: 42 }],
        failed: [],
      })),
    },
  };
});

vi.mock('electron', () => ({
  ipcMain: {
    handle: (
      channel: string,
      fn: (event: unknown, ...args: unknown[]) => unknown | Promise<unknown>,
    ) => {
      mocks.captured.handle.set(channel, fn);
    },
  },
}));

vi.mock('../../cli/desktop-host-api', () => ({
  getDesktopHostWorkspaceLifecycleApi: () => mocks.api,
}));

import { registerWorkspaceLifecycleHandlers } from '../workspace-lifecycle-handlers';

function invoke(channel: string, ...args: unknown[]): Promise<unknown> {
  const handler = mocks.captured.handle.get(channel);
  if (!handler) throw new Error(`no handler registered for ${channel}`);
  return Promise.resolve(handler({}, ...args));
}

beforeEach(() => {
  mocks.captured.handle.clear();
  registerWorkspaceLifecycleHandlers();
});

describe('workspace-lifecycle IPC handlers', () => {
  it('registers one channel per port method', () => {
    expect([...mocks.captured.handle.keys()].sort()).toEqual([
      'workspace-lifecycle:checkout:control',
      'workspace-lifecycle:checkout:observe',
      'workspace-lifecycle:checkout:observe-for-session',
      'workspace-lifecycle:checkout:reclaim',
      'workspace-lifecycle:integration:observe-for-session',
      'workspace-lifecycle:integration:refresh-for-session',
    ]);
  });

  it('forwards a parsed control command and returns the Host result unchanged', async () => {
    const answer = await invoke(
      'workspace-lifecycle:checkout:control',
      'session-1',
      // `bogus` is not a command field: the real parser (imported by the
      // handler) must strip it before the command reaches the Host API.
      { action: 'enter', name: 'task-1', branchName: 'feat', bogus: true },
    );
    expect(answer).toEqual({
      state: { version: 1, revision: 1, cwd: 'C:/repo/worktrees/session-1', checkout: null, pending: null },
      outcome: 'status',
      command: { action: 'enter', name: 'task-1', branchName: 'feat' },
    });
    expect(mocks.api.controlSessionCheckout).toHaveBeenCalledWith('session-1', {
      action: 'enter',
      name: 'task-1',
      branchName: 'feat',
    });
  });

  it('returns the Host checkout view unchanged', async () => {
    const answer = await invoke('workspace-lifecycle:checkout:observe-for-session', 'session-1');
    expect(answer).toEqual({ sessionId: 'session-1', checkout: null, isOwner: false });
  });

  it('returns the Host checkout observation unchanged', async () => {
    const answer = (await invoke(
      'workspace-lifecycle:checkout:observe',
      'C:/repo/worktrees/session-1',
    )) as HostCheckoutObserved;
    expect(answer.root).toBe('C:/repo/worktrees/session-1');
    expect(answer.reclaimable).toBe(true);
  });

  it('returns a reclaim refusal as a normal answer, not an error', async () => {
    const answer = await invoke('workspace-lifecycle:checkout:reclaim', 'C:/repo/worktrees/session-1');
    expect(answer).toEqual({ removed: false, reason: 'dirty_tracked' });
  });

  it('keeps an unknown integration observation unknown', async () => {
    const answer = (await invoke(
      'workspace-lifecycle:integration:observe-for-session',
      'session-1',
    )) as readonly HostIntegrationRecord[];
    expect(answer[0]?.state).toBe('unknown');
    expect(answer[0]?.observedError).toBe('observer_unavailable');
  });

  it('returns the Host sync result unchanged', async () => {
    const answer = await invoke('workspace-lifecycle:integration:refresh-for-session', 'session-1');
    expect(answer).toEqual({
      status: 'synced',
      written: [{ repo: 'owner/repo', prNumber: 42 }],
      failed: [],
    });
  });

  it('refuses a malformed payload instead of forwarding it', async () => {
    await expect(invoke('workspace-lifecycle:checkout:observe-for-session', '')).rejects.toThrow(
      /sessionId/,
    );
    await expect(invoke('workspace-lifecycle:integration:refresh-for-session', '')).rejects.toThrow(
      /sessionId/,
    );
  });

  it('refuses a malformed control command instead of forwarding it', async () => {
    // The forwarding test above already called the mock; clear its history so
    // "not called" means "THIS command never reached the Host API".
    mocks.api.controlSessionCheckout.mockClear();
    await expect(invoke('workspace-lifecycle:checkout:control', '', { action: 'status' })).rejects.toThrow(
      /sessionId/,
    );
    // The real parser rejects a non-object command before it reaches the Host API.
    await expect(invoke('workspace-lifecycle:checkout:control', 'session-1', 'not-a-command')).rejects.toThrow(
      /checkout command object/,
    );
    await expect(invoke('workspace-lifecycle:checkout:control', 'session-1', { action: 'teleport' })).rejects.toThrow(
      /Unknown or invalid checkout action/,
    );
    expect(mocks.api.controlSessionCheckout).not.toHaveBeenCalled();
  });
});
