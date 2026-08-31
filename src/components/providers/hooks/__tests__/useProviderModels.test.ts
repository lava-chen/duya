/**
 * src/components/providers/hooks/__tests__/useProviderModels.test.ts
 *
 * Regression tests for `useProviderModels`. Covers:
 *
 *  1. The fetch path forwards `provider_id` to `fetchProviderModelsIPC`
 *     so the electron main process can resolve the on-disk api key
 *     when the renderer only has the masked hint.
 *
 *  2. The context-window setter (`setContextWindow`) actually
 *     persists the value to the capability table via
 *     `upsertModelCapabilityIPC`, so the user's 1M / 200K picks
 *     survive a reload. Pre-fix, the toggle was purely cosmetic.
 *
 *  3. Hydration from `initialContextWindows` reflects the persisted
 *     values, so the buttons start in the right state on remount.
 */

// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

const fetchProviderModelsMock = vi.fn();
const upsertModelCapabilityMock = vi.fn();

vi.mock('@/lib/ipc-client', () => ({
  fetchProviderModelsIPC: (...args: unknown[]) => fetchProviderModelsMock(...args),
  upsertModelCapabilityIPC: (...args: unknown[]) => upsertModelCapabilityMock(...args),
}));

vi.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    locale: 'en',
    setLocale: vi.fn(),
  }),
}));

import { useProviderModels } from '../useProviderModels';

describe('useProviderModels — fetch contract', () => {
  beforeEach(() => {
    fetchProviderModelsMock.mockReset();
    fetchProviderModelsMock.mockResolvedValue({
      success: true,
      models: [{ id: 'MiniMax-M3', ownedBy: 'anthropic' }],
    });
    upsertModelCapabilityMock.mockReset();
    upsertModelCapabilityMock.mockResolvedValue({
      ok: true,
      capability: {},
    });
  });

  it('forwards the masked apiKey AND provider_id so the main process can resolve the real key', async () => {
    const { result } = renderHook(() =>
      useProviderModels({
        providerId: 'minimax-cn',
        protocol: 'anthropic',
        authStyle: 'api_key',
        baseUrl: 'https://api.minimax.cn',
        // This is the masked hint — the IPC handler must replace
        // it with the on-disk key via the `provider_id` lookup.
        apiKey: 'sk-a***cdef',
        initialEnabled: ['MiniMax-M3'],
        initialContextWindows: {},
      }),
    );

    await act(async () => {
      await result.current.fetch();
    });

    expect(fetchProviderModelsMock).toHaveBeenCalledTimes(1);
    const call = fetchProviderModelsMock.mock.calls[0][0] as Record<string, unknown>;
    // The renderer forwards both the masked hint (so the IPC
    // handler knows the renderer does not have a real key) and
    // the provider id (so the handler can do the on-disk lookup).
    expect(call.api_key).toBe('sk-a***cdef');
    expect(call.provider_id).toBe('minimax-cn');
    expect(call.base_url).toBe('https://api.minimax.cn');
    expect(call.protocol).toBe('anthropic');
  });

  it('records fetched models on success', async () => {
    const { result } = renderHook(() =>
      useProviderModels({
        providerId: 'p1',
        protocol: 'anthropic',
        baseUrl: 'https://api.example.com',
        apiKey: 'sk-real-key-1234567890',
        initialEnabled: [],
        initialContextWindows: {},
      }),
    );

    await act(async () => {
      await result.current.fetch();
    });

    expect(result.current.fetched).toEqual([
      { id: 'MiniMax-M3', ownedBy: 'anthropic' },
    ]);
    expect(result.current.isFetching).toBe(false);
    expect(result.current.fetchError).toBeNull();
  });

  it('surfaces an error message when the upstream returns a non-success result', async () => {
    fetchProviderModelsMock.mockResolvedValueOnce({
      success: false,
      error: { code: 'AUTH_FAILED', message: 'invalid key' },
    });

    const { result } = renderHook(() =>
      useProviderModels({
        providerId: 'p1',
        protocol: 'anthropic',
        baseUrl: 'https://api.example.com',
        apiKey: 'sk-bad',
        initialEnabled: [],
        initialContextWindows: {},
      }),
    );

    await act(async () => {
      await result.current.fetch();
    });

    expect(result.current.fetchError).toBe('invalid key');
    expect(result.current.fetched).toEqual([]);
  });
});

describe('useProviderModels — context window persistence', () => {
  beforeEach(() => {
    fetchProviderModelsMock.mockReset();
    upsertModelCapabilityMock.mockReset();
    upsertModelCapabilityMock.mockResolvedValue({
      ok: true,
      capability: {},
    });
  });

  it('setContextWindow(1M) optimistically updates the local map AND persists to the capability table', async () => {
    const { result } = renderHook(() =>
      useProviderModels({
        providerId: 'p1',
        protocol: 'anthropic',
        baseUrl: 'https://api.example.com',
        apiKey: 'sk-real-key-1234567890',
        initialEnabled: ['MiniMax-M3'],
        initialContextWindows: {},
      }),
    );

    expect(result.current.contextWindows.get('MiniMax-M3')).toBeUndefined();

    act(() => {
      result.current.setContextWindow('MiniMax-M3', 1_000_000);
    });

    // Optimistic local update happens synchronously so the
    // 1M button reflects the user's pick on the same tick.
    expect(result.current.contextWindows.get('MiniMax-M3')).toBe(1_000_000);

    // Persistence runs in the background. Flush the
    // microtask queue so the fire-and-forget promise has a
    // chance to resolve before we assert on the call args.
    await act(async () => {
      await Promise.resolve();
    });

    expect(upsertModelCapabilityMock).toHaveBeenCalledTimes(1);
    const call = upsertModelCapabilityMock.mock.calls[0][0] as Record<string, unknown>;
    expect(call.providerId).toBe('p1');
    expect(call.modelId).toBe('MiniMax-M3');
    expect(call.contextWindow).toBe(1_000_000);
    expect(call.source).toBe('user');
  });

  it('setContextWindow(0) clears the entry and persists contextWindow=0', async () => {
    const { result } = renderHook(() =>
      useProviderModels({
        providerId: 'p1',
        protocol: 'anthropic',
        baseUrl: 'https://api.example.com',
        apiKey: 'sk-real-key-1234567890',
        initialEnabled: ['MiniMax-M3'],
        initialContextWindows: { 'MiniMax-M3': 1_000_000 },
      }),
    );

    // Sanity: the initial value is hydrated.
    expect(result.current.contextWindows.get('MiniMax-M3')).toBe(1_000_000);

    act(() => {
      result.current.setContextWindow('MiniMax-M3', 0);
    });

    // The local map is cleared so the button toggles off.
    expect(result.current.contextWindows.has('MiniMax-M3')).toBe(false);

    await act(async () => {
      await Promise.resolve();
    });

    expect(upsertModelCapabilityMock).toHaveBeenCalledTimes(1);
    const call = upsertModelCapabilityMock.mock.calls[0][0] as Record<string, unknown>;
    expect(call.contextWindow).toBe(0);
  });

  it('hydrates the local map from initialContextWindows so the 1M/200K buttons reflect saved state', () => {
    const { result } = renderHook(() =>
      useProviderModels({
        providerId: 'p1',
        protocol: 'anthropic',
        baseUrl: 'https://api.example.com',
        apiKey: 'sk-real-key-1234567890',
        initialEnabled: ['MiniMax-M3'],
        initialContextWindows: { 'MiniMax-M3': 1_000_000, 'claude-sonnet-4-6': 200_000 },
      }),
    );

    expect(result.current.contextWindows.get('MiniMax-M3')).toBe(1_000_000);
    expect(result.current.contextWindows.get('claude-sonnet-4-6')).toBe(200_000);
  });

  // Plan 209 fix-up: regression test for the async-hydration
  // case. The view calls `listModelCapabilitiesIPC` on mount
  // and passes the result to the hook via `initialContextWindows`
  // AFTER the hook has already been mounted with an empty map.
  // Pre-fix, the hook's internal state was initialized via
  // `useState(() => new Map(...))` and never re-synced, so the
  // 1M/200K buttons started un-set even when the DB had a saved
  // 1M. This test renders the hook with an empty prop, re-renders
  // with a populated prop, and asserts the state catches up.
  it('re-syncs the local map when initialContextWindows changes after mount (async hydration)', () => {
    const { result, rerender } = renderHook(
      ({ initial }: { initial: Record<string, number> }) =>
        useProviderModels({
          providerId: 'p1',
          protocol: 'anthropic',
          baseUrl: 'https://api.example.com',
          apiKey: 'sk-real-key-1234567890',
          initialEnabled: ['MiniMax-M3'],
          initialContextWindows: initial,
        }),
      { initialProps: { initial: {} as Record<string, number> } },
    );

    // First render: the IPC hasn't returned yet, the map is empty.
    expect(result.current.contextWindows.get('MiniMax-M3')).toBeUndefined();

    // Re-render with the populated map (simulating the IPC
    // returning and the parent calling `setInitialContextWindows`).
    rerender({ initial: { 'MiniMax-M3': 1_000_000, 'claude-sonnet-4-6': 200_000 } });

    expect(result.current.contextWindows.get('MiniMax-M3')).toBe(1_000_000);
    expect(result.current.contextWindows.get('claude-sonnet-4-6')).toBe(200_000);
  });

  // Plan 209 fix-up: a user click that happens BEFORE the IPC
  // hydration completes must NOT be clobbered by the late
  // capability value. The hook is "additive": new keys from
  // the prop are merged in, but existing keys (user-modified)
  // are preserved.
  it('preserves a user click that happens before async hydration completes', () => {
    const { result, rerender } = renderHook(
      ({ initial }: { initial: Record<string, number> }) =>
        useProviderModels({
          providerId: 'p1',
          protocol: 'anthropic',
          baseUrl: 'https://api.example.com',
          apiKey: 'sk-real-key-1234567890',
          initialEnabled: ['MiniMax-M3'],
          initialContextWindows: initial,
        }),
      { initialProps: { initial: {} as Record<string, number> } },
    );

    // User clicks 1M for `MiniMax-M3` while the IPC is in flight.
    act(() => {
      result.current.setContextWindow('MiniMax-M3', 1_000_000);
    });
    expect(result.current.contextWindows.get('MiniMax-M3')).toBe(1_000_000);

    // IPC returns with 200K for the same model (e.g. the user
    // changed their mind in another tab). The local pick wins.
    rerender({ initial: { 'MiniMax-M3': 200_000 } });

    expect(result.current.contextWindows.get('MiniMax-M3')).toBe(1_000_000);
  });

  it('does NOT persist when providerId is missing (new-provider flow)', async () => {
    const { result } = renderHook(() =>
      useProviderModels({
        protocol: 'anthropic',
        baseUrl: 'https://api.example.com',
        apiKey: 'sk-new-key',
        initialEnabled: ['MiniMax-M3'],
        initialContextWindows: {},
      }),
    );

    act(() => {
      result.current.setContextWindow('MiniMax-M3', 1_000_000);
    });

    // The local map still updates so the UI is responsive.
    expect(result.current.contextWindows.get('MiniMax-M3')).toBe(1_000_000);

    await act(async () => {
      await Promise.resolve();
    });

    // But nothing is sent over IPC because there is no row
    // to upsert against yet (the user has not saved the
    // provider).
    expect(upsertModelCapabilityMock).not.toHaveBeenCalled();
  });
});
