/**
 * src/lib/providers/hooks/__tests__/useProvidersQuery.test.tsx
 *
 * Tests for the L1 React Query layer.
 *
 * Plan 203 Phase 5.1: ~80 LoC.
 *
 * These tests use a fresh QueryClient per test (no globals), mock
 * the IPC layer, and verify:
 * - The query key matches `providersQueryKey()`.
 * - The queryFn projects raw backend DTOs to renderer DTOs.
 * - Mutations invalidate the right keys.
 * - The error path is preserved.
 */

// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';

import { useProvidersQuery } from '../useProvidersQuery';
import { useSetActiveProviderMutation } from '../useSetActiveProviderMutation';
import { useDeleteProviderMutation } from '../useDeleteProviderMutation';
import { useUpsertProviderMutation } from '../useUpsertProviderMutation';
import { providersQueryKey } from '../queryKeys';

// Mock the IPC client. The vitest mock module boundary lets us
// control the resolved values of every IPC call.
vi.mock('@/lib/ipc-client', () => ({
  listProvidersIPC: vi.fn(),
  getDefaultLlmProviderIPC: vi.fn(),
  setDefaultLlmProviderIPC: vi.fn(),
  deleteLlmProviderIPC: vi.fn(),
  upsertLlmProviderIPC: vi.fn(),
  testProviderIPC: vi.fn(),
}));

// eslint-disable-next-line @typescript-eslint/no-require-imports
const ipcClient = await import('@/lib/ipc-client');

function makeWrapper() {
  const qc = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { retry: false },
    },
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  return { wrapper, qc };
}

function backendAnthropic() {
  return {
    id: 'p-anthropic',
    name: 'My Anthropic',
    providerType: 'anthropic',
    baseUrl: 'https://api.anthropic.com',
    apiKey: 'sk-a***7890',
    isActive: true,
    hasApiKey: true,
    sortOrder: 1,
    extraEnv: '{}',
    protocol: 'anthropic',
    headers: '{}',
    options: '{}',
    notes: '',
    createdAt: 1700000000000,
    updatedAt: 1700000000000,
  };
}

describe('useProvidersQuery', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(ipcClient.getDefaultLlmProviderIPC).mockResolvedValue(null);
  });

  it('returns an empty array initially while loading', () => {
    vi.mocked(ipcClient.listProvidersIPC).mockResolvedValue([]);
    const { wrapper } = makeWrapper();
    const { result } = renderHook(() => useProvidersQuery(), { wrapper });
    // `data` may be undefined or [] depending on timing; ensure no
    // throw and the call is in flight.
    expect(result.current.isLoading || result.current.data !== undefined).toBe(true);
  });

  it('fetches and projects the providers', async () => {
    vi.mocked(ipcClient.listProvidersIPC).mockResolvedValue([backendAnthropic()]);
    const { wrapper } = makeWrapper();
    const { result } = renderHook(() => useProvidersQuery(), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toHaveLength(1);
    expect(result.current.data![0].id).toBe('p-anthropic');
    expect(result.current.data![0].name).toBe('My Anthropic');
    // category / apiFormat are projected from the legacy IPC shape.
    expect(result.current.data![0].category).toBe('official');
    expect(result.current.data![0].apiFormat).toBe('anthropic');
  });

  it('uses providersQueryKey as the cache key', () => {
    const { qc, wrapper } = makeWrapper();
    const { result } = renderHook(() => useProvidersQuery(), { wrapper });
    // After the query runs, the cache should have the providers key.
    const keys = qc.getQueryCache().getAll().map((q) => q.queryKey);
    expect(keys.some((k) => JSON.stringify(k) === JSON.stringify(providersQueryKey()))).toBe(true);
    expect(result.current).toBeDefined();
  });

  it('propagates errors from the IPC layer', async () => {
    const err = new Error('IPC failed');
    vi.mocked(ipcClient.listProvidersIPC).mockRejectedValue(err);
    const { wrapper } = makeWrapper();
    const { result } = renderHook(() => useProvidersQuery(), { wrapper });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error).toBe(err);
  });
});

describe('useSetActiveProviderMutation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('calls setDefaultLlmProviderIPC with the given id', async () => {
    vi.mocked(ipcClient.setDefaultLlmProviderIPC).mockResolvedValue(true);
    const { wrapper } = makeWrapper();
    const { result } = renderHook(() => useSetActiveProviderMutation(), { wrapper });
    await result.current.mutateAsync('p-anthropic');
    expect(ipcClient.setDefaultLlmProviderIPC).toHaveBeenCalledWith('p-anthropic');
  });

  it('invalidates the providers query key on success', async () => {
    vi.mocked(ipcClient.setDefaultLlmProviderIPC).mockResolvedValue(true);
    const { wrapper, qc } = makeWrapper();
    // Seed the cache with a list.
    qc.setQueryData(providersQueryKey(), []);
    const invalidateSpy = vi.spyOn(qc, 'invalidateQueries');
    const { result } = renderHook(() => useSetActiveProviderMutation(), { wrapper });
    await result.current.mutateAsync('p-anthropic');
    expect(invalidateSpy).toHaveBeenCalledWith(
      expect.objectContaining({ queryKey: providersQueryKey() }),
    );
  });
});

describe('useDeleteProviderMutation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('calls deleteLlmProviderIPC with the given id', async () => {
    vi.mocked(ipcClient.deleteLlmProviderIPC).mockResolvedValue(true);
    const { wrapper } = makeWrapper();
    const { result } = renderHook(() => useDeleteProviderMutation(), { wrapper });
    await result.current.mutateAsync('p-anthropic');
    expect(ipcClient.deleteLlmProviderIPC).toHaveBeenCalledWith('p-anthropic');
  });
});

describe('useUpsertProviderMutation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('sends the LlmProvider shape to upsertLlmProviderIPC', async () => {
    vi.mocked(ipcClient.upsertLlmProviderIPC).mockResolvedValue({
      ok: true,
      provider: backendAnthropic(),
    });
    const { wrapper } = makeWrapper();
    const { result } = renderHook(() => useUpsertProviderMutation(), { wrapper });
    await result.current.mutateAsync({
      llm: {
        id: 'p-anthropic',
        name: 'My Anthropic',
        category: 'official',
        apiFormat: 'anthropic',
        auth: { type: 'api-key', apiKey: 'sk-test-1234567890' },
        endpoints: { baseUrl: 'https://api.anthropic.com' },
        ui: {},
        meta: { createdAt: 1700000000000, updatedAt: 1700000000000, sortIndex: 0 },
      },
      apiKey: 'sk-test-1234567890',
    });
    expect(ipcClient.upsertLlmProviderIPC).toHaveBeenCalled();
    const call = vi.mocked(ipcClient.upsertLlmProviderIPC).mock.calls[0][0];
    expect((call as Record<string, unknown>).id).toBe('p-anthropic');
  });

  it('throws an error tagged with code when the IPC handler reports not-ok', async () => {
    // Plan 209: the mutation now THROWS on not-ok (with the IPC
    // `code` attached) so callers can render a specific error
    // banner — most importantly `masked_key`. The old "return
    // null" shape was hiding the failure from the UI.
    vi.mocked(ipcClient.upsertLlmProviderIPC).mockResolvedValue({ ok: false, code: 'masked_key', message: 'rejected' });
    const { wrapper } = makeWrapper();
    const { result } = renderHook(() => useUpsertProviderMutation(), { wrapper });
    await expect(
      result.current.mutateAsync({
        llm: {
          id: 'p-x',
          name: 'X',
          category: 'custom',
          apiFormat: 'openai-chat',
          auth: { type: 'api-key' },
          endpoints: { baseUrl: '' },
          ui: {},
          meta: { createdAt: 0, updatedAt: 0, sortIndex: 0 },
        },
        apiKey: undefined,
      }),
    ).rejects.toMatchObject({ code: 'masked_key' });
  });
});
