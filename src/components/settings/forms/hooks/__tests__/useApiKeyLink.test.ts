/**
 * src/components/settings/forms/hooks/__tests__/useApiKeyLink.test.ts
 *
 * Plan 203 Phase 5.1 tests for `useApiKeyLink`. The hook normalizes
 * a `ProviderPreset` or legacy `QuickPreset` into a
 * `{ apiKeyUrl, docsUrl, openApiKeyLink }` triple and delegates
 * the actual window.open call to `useOpenExternal`.
 */

// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useApiKeyLink } from '../useApiKeyLink';
import type { ProviderPreset } from '@/lib/providers';
import type { QuickPreset } from '@/lib/provider-presets';

function makePreset(overrides: Partial<ProviderPreset> = {}): ProviderPreset {
  return {
    key: 'anthropic',
    name: 'Anthropic',
    category: 'official',
    apiFormat: 'anthropic',
    authFields: [],
    defaultEndpoint: 'https://api.anthropic.com',
    modelsSource: { type: 'static' },
    ui: {},
    ...overrides,
  };
}

function makeQuickPreset(overrides: Partial<QuickPreset> = {}): QuickPreset {
  return {
    key: 'openai',
    name: 'OpenAI',
    provider_type: 'openai',
    baseUrl: 'https://api.openai.com',
    fields: [],
    iconKey: 'openai',
    ...overrides,
  } as QuickPreset;
}

describe('useApiKeyLink', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('returns null when the preset is null', () => {
    const { result } = renderHook(() => useApiKeyLink({ preset: null }));
    expect(result.current.apiKeyUrl).toBeNull();
    expect(result.current.docsUrl).toBeNull();
  });

  it('reads apiKeyUrl and docsUrl from a ProviderPreset', () => {
    const preset = makePreset({
      ui: { apiKeyUrl: 'https://console.anthropic.com/keys', docsUrl: 'https://docs.anthropic.com' },
    });
    const { result } = renderHook(() => useApiKeyLink({ preset }));
    expect(result.current.apiKeyUrl).toBe('https://console.anthropic.com/keys');
    expect(result.current.docsUrl).toBe('https://docs.anthropic.com');
  });

  it('falls back to docsUrl for a QuickPreset', () => {
    const preset = makeQuickPreset({
      meta: { docsUrl: 'https://platform.openai.com/api-keys' },
    });
    const { result } = renderHook(() => useApiKeyLink({ preset }));
    expect(result.current.apiKeyUrl).toBe('https://platform.openai.com/api-keys');
    expect(result.current.docsUrl).toBe('https://platform.openai.com/api-keys');
  });

  it('returns null apiKeyUrl when the ProviderPreset has no apiKeyUrl', () => {
    const preset = makePreset({ ui: { docsUrl: 'https://docs.example.com' } });
    const { result } = renderHook(() => useApiKeyLink({ preset }));
    expect(result.current.apiKeyUrl).toBeNull();
    expect(result.current.docsUrl).toBe('https://docs.example.com');
  });

  it('openApiKeyLink calls window.open with the apiKeyUrl', () => {
    const openSpy = vi.spyOn(window, 'open').mockImplementation(() => null);
    const preset = makePreset({
      ui: { apiKeyUrl: 'https://console.anthropic.com/keys' },
    });
    const { result } = renderHook(() => useApiKeyLink({ preset }));
    act(() => result.current.openApiKeyLink());
    expect(openSpy).toHaveBeenCalledWith(
      'https://console.anthropic.com/keys',
      '_blank',
      'noopener,noreferrer',
    );
  });

  it('openApiKeyLink is a no-op when apiKeyUrl is null', () => {
    const openSpy = vi.spyOn(window, 'open').mockImplementation(() => null);
    const { result } = renderHook(() => useApiKeyLink({ preset: null }));
    act(() => result.current.openApiKeyLink());
    expect(openSpy).not.toHaveBeenCalled();
  });
});
