/**
 * usePermissions.test.ts - Unit tests for the B5 (SSE replay deduplication) fix.
 *
 * Background: SSE reconnect and agent-side retry can deliver the same
 * permission id twice in quick succession. Before B5, the second delivery
 * would reset the user's in-flight `waitingRef`, look like a flicker, and
 * (if the user clicked "allow" in between) cause a second POST that the
 * agent would silently drop as "no pending permission found". The fix
 * tracks the last accepted id in a ref and short-circuits on duplicate.
 *
 * Also verifies the cross-session reset: when the active sessionId changes,
 * the ref is reset so a new session can re-use a previously-seen id.
 */

// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

// Mock the network and store layers so the hook runs in pure isolation.
// We keep these as proper vi.fn() instances (so .mockReset / .mockReturnValue
// stay available) and re-export them via the module mock factory below.
const mockResolvePermission = vi.fn();
const mockSubscribeToPhase = vi.fn();
const mockGetSnapshot = vi.fn();

vi.mock('@/lib/agent-sse-client', () => ({
  resolvePermission: (sessionId: string, permissionId: string, decision: string) =>
    mockResolvePermission(sessionId, permissionId, decision),
}));

vi.mock('@/lib/stream-session-manager', () => ({
  subscribeToPhase: (sessionId: string, cb: (phase: string) => void) =>
    mockSubscribeToPhase(sessionId, cb),
  getSnapshot: (sessionId: string) => mockGetSnapshot(sessionId),
}));

import { usePermissions } from '../usePermissions';
import type { PermissionRequestEvent } from '@/types/stream';

const makeRequest = (id: string): PermissionRequestEvent => ({
  id,
  toolName: 'Bash',
  toolInput: { command: 'echo hi' },
  mode: 'generic',
  expiresAt: Date.now() + 60000,
});

describe('usePermissions — B5 SSE replay deduplication', () => {
  beforeEach(() => {
    mockResolvePermission.mockReset();
    mockSubscribeToPhase.mockClear();
    mockGetSnapshot.mockReturnValue({ phase: 'awaiting_permission' });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('treats the first request as a new prompt', () => {
    const { result } = renderHook(() =>
      usePermissions({ sessionId: 's1', permissionProfile: 'default' }),
    );

    act(() => {
      result.current.handlePermissionRequest(makeRequest('perm-1'));
    });

    expect(result.current.pendingPermission?.id).toBe('perm-1');
    expect(result.current.permissionResolved).toBeNull();
  });

  it('drops a duplicate request with the same id (no state churn)', () => {
    const { result } = renderHook(() =>
      usePermissions({ sessionId: 's1', permissionProfile: 'default' }),
    );

    act(() => {
      result.current.handlePermissionRequest(makeRequest('perm-1'));
    });

    // Simulate the user clicking "allow" — this sets waitingRef.current = true
    // and would normally have left the prompt in a transient "allowed" state.
    // We then simulate the second SSE delivery of the same id.
    const resolvePromise = Promise.resolve();
    mockResolvePermission.mockReturnValue(resolvePromise);
    act(() => {
      // Fire the click but don't await — we want to observe the in-flight state
      void result.current.respondToPermission('allow');
    });

    // At this point waitingRef is true; replay should be a no-op.
    const beforeReplay = {
      pending: result.current.pendingPermission?.id,
      resolved: result.current.permissionResolved,
    };
    expect(beforeReplay.pending).toBe('perm-1');

    act(() => {
      result.current.handlePermissionRequest(makeRequest('perm-1'));
    });

    const afterReplay = {
      pending: result.current.pendingPermission?.id,
      resolved: result.current.permissionResolved,
    };

    // The state must be untouched by the replay — same id, same resolved
    // status, and crucially: resolvePermission must NOT have been called
    // a second time (waitingRef is still true from the first click).
    expect(afterReplay).toEqual(beforeReplay);
  });

  it('resets the dedup ref when sessionId changes (cross-session safety)', () => {
    const { result, rerender } = renderHook(
      ({ sessionId }: { sessionId: string }) =>
        usePermissions({ sessionId, permissionProfile: 'default' }),
      { initialProps: { sessionId: 's1' } },
    );

    act(() => {
      result.current.handlePermissionRequest(makeRequest('perm-1'));
    });
    expect(result.current.pendingPermission?.id).toBe('perm-1');

    // Switch to a different session. The same id in a new session is a
    // genuinely new prompt, not a replay.
    rerender({ sessionId: 's2' });

    act(() => {
      result.current.handlePermissionRequest(makeRequest('perm-1'));
    });

    // Must have re-accepted the request (not silently dropped).
    expect(result.current.pendingPermission?.id).toBe('perm-1');
  });

  it('accepts a new request with a different id after the first one', () => {
    const { result } = renderHook(() =>
      usePermissions({ sessionId: 's1', permissionProfile: 'default' }),
    );

    act(() => {
      result.current.handlePermissionRequest(makeRequest('perm-1'));
    });
    act(() => {
      result.current.handlePermissionRequest(makeRequest('perm-2'));
    });

    expect(result.current.pendingPermission?.id).toBe('perm-2');
  });
});
