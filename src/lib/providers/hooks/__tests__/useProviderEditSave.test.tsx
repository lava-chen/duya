/**
 * src/lib/providers/hooks/__tests__/useProviderEditSave.test.tsx
 *
 * Plan 209 Phase H tests for the 3-state api key save contract.
 *
 * The mutation is mocked. We assert:
 *  - on edit, untouched state → mutation called with `apiKey: undefined`
 *  - on edit, replaced state → mutation called with `apiKey: <raw>`
 *  - on edit, cleared state → mutation called with `apiKey: ''`
 *  - on add, replaced state → same (replacement semantics)
 */

// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

const mutateAsyncMock = vi.fn();
vi.mock('../useUpsertProviderMutation', () => ({
  useUpsertProviderMutation: () => ({
    mutateAsync: mutateAsyncMock,
    isPending: false,
    error: null,
  }),
}));

vi.mock('@/lib/providers', () => ({
  findPresetByKey: vi.fn(() => ({
    key: 'anthropic',
    category: 'official',
    apiFormat: 'anthropic',
    ui: { docsUrl: 'https://docs' },
  })),
  // The save hook now falls back to this mapper when `findPresetByKey`
  // misses (LM Studio path: catalog key is 'lm-studio' but the form sends
  // provider_type='openai-compatible'). The real mapper is in @duya/ai;
  // the test only needs it to exist so the import resolves.
  inferApiFormatFromLegacyProviderType: vi.fn(
    (providerType: string) =>
      (providerType === 'anthropic' ? 'anthropic' : 'openai-chat') as never,
  ),
}));

import { useProviderEditSave } from '../useProviderEditSave';

const makeData = (api_key: string | undefined) => ({
  name: 'TestProvider',
  provider_type: 'anthropic',
  protocol: 'anthropic',
  base_url: 'https://api.example.com',
  api_key,
  extra_env: '{}',
});

describe('useProviderEditSave — 3-state api key contract', () => {
  beforeEach(() => {
    mutateAsyncMock.mockReset();
    mutateAsyncMock.mockResolvedValue({});
  });

  it('edit + untouched → mutation apiKey is undefined', async () => {
    const { result } = renderHook(() => useProviderEditSave());
    await act(async () => {
      await result.current.save(makeData(undefined), 'p1');
    });
    expect(mutateAsyncMock).toHaveBeenCalledTimes(1);
    const arg = mutateAsyncMock.mock.calls[0][0] as { apiKey: unknown; llm: { id: string } };
    expect(arg.apiKey).toBeUndefined();
    expect(arg.llm.id).toBe('p1');
  });

  it('edit + replaced → mutation apiKey is the raw string', async () => {
    const { result } = renderHook(() => useProviderEditSave());
    await act(async () => {
      await result.current.save(makeData('sk-new-1234567890'), 'p1');
    });
    const arg = mutateAsyncMock.mock.calls[0][0] as { apiKey: unknown };
    expect(arg.apiKey).toBe('sk-new-1234567890');
  });

  it('edit + cleared → mutation apiKey is empty string', async () => {
    const { result } = renderHook(() => useProviderEditSave());
    await act(async () => {
      await result.current.save(makeData(''), 'p1');
    });
    const arg = mutateAsyncMock.mock.calls[0][0] as { apiKey: unknown };
    expect(arg.apiKey).toBe('');
  });

  it('add + replaced → mutation apiKey is the raw string', async () => {
    const { result } = renderHook(() => useProviderEditSave());
    await act(async () => {
      await result.current.save(makeData('sk-new-1234567890'), null);
    });
    const arg = mutateAsyncMock.mock.calls[0][0] as { apiKey: unknown; llm: { id: string } };
    expect(arg.apiKey).toBe('sk-new-1234567890');
    expect(arg.llm.id).not.toBe('p1');
    expect(arg.llm.id).toMatch(/^testprovider/);
  });

  it('propagates the error from the mutation', async () => {
    mutateAsyncMock.mockRejectedValue(new Error('masked_key: rejected'));
    const { result } = renderHook(() => useProviderEditSave());
    await expect(
      act(async () => {
        await result.current.save(makeData('sk-new-1234567890'), 'p1');
      }),
    ).rejects.toThrow('masked_key: rejected');
  });

  it('threads options onto LlmProvider.options (Plan 209 P4-prime)', async () => {
    // The form passes the structured `options` object so the
    // chat agent can read `defaultModel` / `enabled_models` from
    // the IPC runtime config. Without this path, the user saves
    // a provider successfully but `getActiveProviderConfig` sees
    // an empty `model` and the chat fails to start.
    const { result } = renderHook(() => useProviderEditSave());
    await act(async () => {
      await result.current.save(
        {
          ...makeData('sk-new-1234567890'),
          options: {
            enabled_models: ['claude-sonnet-4-6'],
            defaultModel: 'claude-sonnet-4-6',
            title_model: 'claude-3-5-haiku-20241022',
          },
        },
        'p1',
      );
    });
    const arg = mutateAsyncMock.mock.calls[0][0] as {
      llm: { options?: Record<string, unknown> };
    };
    expect(arg.llm.options).toEqual({
      enabled_models: ['claude-sonnet-4-6'],
      defaultModel: 'claude-sonnet-4-6',
      title_model: 'claude-3-5-haiku-20241022',
    });
  });

  it('LM Studio fallback: provider_type="openai-compatible" → apiFormat="openai-chat"', async () => {
    // LM Studio's catalog key is 'lm-studio' but the form sends
    // provider_type='openai-compatible' (set by
    // `mapCatalogProtocolToPresetProtocol` in @/lib/provider-presets).
    // The default `findPresetByKey` mock returns an anthropic preset,
    // so we override it to return undefined for this case, mirroring the
    // real miss path that triggered the original bug.
    const { findPresetByKey } = await import('@/lib/providers');
    (findPresetByKey as unknown as ReturnType<typeof vi.fn>).mockReturnValueOnce(
      undefined,
    );
    const { inferApiFormatFromLegacyProviderType } = await import(
      '@/lib/providers'
    );
    const mapperMock = inferApiFormatFromLegacyProviderType as unknown as ReturnType<
      typeof vi.fn
    >;
    mapperMock.mockClear();

    const { result } = renderHook(() => useProviderEditSave());
    await act(async () => {
      await result.current.save(
        { ...makeData('sk-new-1234567890'), provider_type: 'openai-compatible' },
        'p1',
      );
    });

    const arg = mutateAsyncMock.mock.calls[0][0] as {
      llm: { apiFormat?: string };
    };
    // Must be 'openai-chat' (a valid ApiFormat), NOT 'openai-compatible'
    // (which would be rejected by electron `validateProvider`).
    expect(arg.llm.apiFormat).toBe('openai-chat');
    expect(mapperMock).toHaveBeenCalledWith('openai-compatible');
  });
});
