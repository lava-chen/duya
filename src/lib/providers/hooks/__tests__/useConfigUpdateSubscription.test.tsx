/**
 * src/lib/providers/hooks/__tests__/useConfigUpdateSubscription.test.tsx
 *
 * Plan 203 Phase 1.3 deliverable: a single test verifying that the
 * subscription handler calls `invalidateQueries` with the right keys
 * when the Electron `config:update` broadcast fires. The hook is a
 * thin bridge from the IPC MessagePort into the React Query cache.
 *
 * We mock `window.electronAPI.getConfigPort` to return a stub port
 * whose `onConfigUpdate` invokes the registered handler synchronously.
 * We then assert the expected `invalidateQueries` calls.
 */

// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';

import { useConfigUpdateSubscription } from '../useConfigUpdateSubscription';
import { providersQueryKey } from '../queryKeys';

interface UpdateHandler {
  (config: unknown): void;
}

interface ConfigPortStub {
  onConfigUpdate: (handler: UpdateHandler) => () => void;
  trigger: (config?: unknown) => void;
}

function installConfigPortStub(): ConfigPortStub {
  let handler: UpdateHandler | null = null;
  const stub: ConfigPortStub = {
    onConfigUpdate: (h) => {
      handler = h;
      return () => {
        handler = null;
      };
    },
    trigger: (config) => {
      if (handler) handler(config);
    },
  };
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    getConfigPort: () => stub,
  };
  return stub;
}

function makeWrapper() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  return { wrapper, qc };
}

describe('useConfigUpdateSubscription', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('invalidates the providers query key on config:update broadcast', () => {
    const port = installConfigPortStub();
    const { qc, wrapper } = makeWrapper();
    const invalidateSpy = vi.spyOn(qc, 'invalidateQueries');

    renderHook(() => useConfigUpdateSubscription(), { wrapper });

    // Pre-seed the cache so we can also verify it gets the broad
    // providers key (not just the typed `providersQueryKey()` tuple).
    qc.setQueryData(providersQueryKey(), []);

    // Trigger the broadcast.
    port.trigger({});

    // Expect at least the broad providers key to be invalidated.
    const calls = invalidateSpy.mock.calls.map((c) => c[0]);
    expect(
      calls.some(
        (c) =>
          c &&
          typeof c === 'object' &&
          Array.isArray((c as { queryKey: readonly unknown[] }).queryKey) &&
          JSON.stringify((c as { queryKey: readonly unknown[] }).queryKey) ===
            JSON.stringify(providersQueryKey()),
      ),
    ).toBe(true);
  });

  it('does nothing when electronAPI is unavailable', () => {
    (window as unknown as { electronAPI: unknown }).electronAPI = undefined;
    const { qc, wrapper } = makeWrapper();
    const invalidateSpy = vi.spyOn(qc, 'invalidateQueries');

    expect(() =>
      renderHook(() => useConfigUpdateSubscription(), { wrapper }),
    ).not.toThrow();
    expect(invalidateSpy).not.toHaveBeenCalled();
  });
});
