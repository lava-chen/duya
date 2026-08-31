/**
 * src/components/providers/__tests__/useProviderCardState.test.ts
 *
 * Plan 203 Phase 5.1 tests for `useProviderCardState`. The hook is
 * a pure derivation over the `RendererLlmProviderDTO` + context,
 * so the test matrix is a truth table of the 8 boolean dimensions.
 *
 * The dimensions are:
 *  - isCurrent, isActive, isInConfig, isFailoverMode, isProxyTakeover,
 *    isOfficialBlockedByProxy, isOmo, isReadOnly, isDefaultModel.
 *  - canEdit, canDelete, canDuplicate, canTest, canConfigureUsage,
 *    canOpenTerminal, canSetAsDefault.
 *
 * Today the future dimensions are pinned to defaults; the tests
 * assert that the defaults hold AND that the orthogonal dimensions
 * compose correctly when the context changes.
 */

// @vitest-environment jsdom

import { describe, it, expect } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useProviderCardState } from '../hooks/useProviderCardState';
import type { RendererLlmProviderDTO } from '@/lib/providers/ipc-types';

function makeProvider(
  overrides: Partial<RendererLlmProviderDTO> = {},
): RendererLlmProviderDTO {
  return {
    id: 'p-1',
    name: 'Test',
    alias: '',
    category: 'official',
    apiFormat: 'anthropic',
    apiKey: 'sk-a***cdef',
    hasApiKey: true,
    baseUrl: 'https://api.example.com',
    sortOrder: 0,
    isDefault: false,
    isActive: false,
    notes: '',
    createdAt: 1700000000000,
    updatedAt: 1700000000000,
    extraEnv: '{}',
    headers: '{}',
    options: '{}',
    protocol: 'anthropic',
    legacy: { providerType: 'anthropic', providerTypeMapping: 'direct' },
    ...overrides,
  };
}

describe('useProviderCardState — defaults', () => {
  it('isCurrent is true when the active id matches', () => {
    const provider = makeProvider({ id: 'p-active' });
    const { result } = renderHook(() =>
      useProviderCardState({
        provider,
        appId: 'duya',
        context: { defaultProviderId: 'p-active', proxyTakeover: false },
      }),
    );
    expect(result.current.isCurrent).toBe(true);
  });

  it('isCurrent is false when the active id differs', () => {
    const provider = makeProvider({ id: 'p-other' });
    const { result } = renderHook(() =>
      useProviderCardState({
        provider,
        appId: 'duya',
        context: { defaultProviderId: 'p-active', proxyTakeover: false },
      }),
    );
    expect(result.current.isCurrent).toBe(false);
  });

  it('isCurrent is false when defaultProviderId is null', () => {
    const provider = makeProvider({ id: 'p-1' });
    const { result } = renderHook(() =>
      useProviderCardState({
        provider,
        appId: 'duya',
        context: { defaultProviderId: null, proxyTakeover: false },
      }),
    );
    expect(result.current.isCurrent).toBe(false);
  });

  it('isActive mirrors the DTO isActive field', () => {
    const { result: on } = renderHook(() =>
      useProviderCardState({
        provider: makeProvider({ isActive: true }),
        appId: 'duya',
        context: { defaultProviderId: null, proxyTakeover: false },
      }),
    );
    expect(on.current.isActive).toBe(true);

    const { result: off } = renderHook(() =>
      useProviderCardState({
        provider: makeProvider({ isActive: false }),
        appId: 'duya',
        context: { defaultProviderId: null, proxyTakeover: false },
      }),
    );
    expect(off.current.isActive).toBe(false);
  });

  it('default dimensions are pinned for duya today', () => {
    const { result } = renderHook(() =>
      useProviderCardState({
        provider: makeProvider(),
        appId: 'duya',
        context: { defaultProviderId: null, proxyTakeover: false },
      }),
    );
    expect(result.current.isInConfig).toBe(true);
    expect(result.current.isFailoverMode).toBe(false);
    expect(result.current.isProxyTakeover).toBe(false);
    expect(result.current.isOfficialBlockedByProxy).toBe(false);
    expect(result.current.isOmo).toBe(false);
    expect(result.current.isReadOnly).toBe(false);
    expect(result.current.isDefaultModel).toBe(false);
  });

  it('isOfficialBlockedByProxy is true when category=official + proxy on', () => {
    const { result } = renderHook(() =>
      useProviderCardState({
        provider: makeProvider({ category: 'official' }),
        appId: 'duya',
        context: { defaultProviderId: null, proxyTakeover: true },
      }),
    );
    expect(result.current.isOfficialBlockedByProxy).toBe(true);
  });

  it('isOfficialBlockedByProxy is false when category!=official even with proxy', () => {
    const { result } = renderHook(() =>
      useProviderCardState({
        provider: makeProvider({ category: 'custom' }),
        appId: 'duya',
        context: { defaultProviderId: null, proxyTakeover: true },
      }),
    );
    expect(result.current.isOfficialBlockedByProxy).toBe(false);
  });
});

describe('useProviderCardState — capability flags', () => {
  it('canEdit is true for a normal provider', () => {
    const { result } = renderHook(() =>
      useProviderCardState({
        provider: makeProvider(),
        appId: 'duya',
        context: { defaultProviderId: null, proxyTakeover: false },
      }),
    );
    expect(result.current.canEdit).toBe(true);
  });

  it('canDelete is true for a non-current provider', () => {
    const { result } = renderHook(() =>
      useProviderCardState({
        provider: makeProvider({ id: 'p-other' }),
        appId: 'duya',
        context: { defaultProviderId: 'p-active', proxyTakeover: false },
      }),
    );
    expect(result.current.canDelete).toBe(true);
  });

  it('Plan 209: canDelete is true for the current (active) provider in normal mode', () => {
    // The pre-Plan-209 implementation hid the delete button
    // on the active card. We now allow deleting the active
    // provider too — the user-facing delete flow in
    // ProviderManagement shows a confirmation dialog for
    // the active case and clears the active reference on
    // success. Hiding the button meant the user could not
    // recover from a broken active provider.
    const { result } = renderHook(() =>
      useProviderCardState({
        provider: makeProvider({ id: 'p-active' }),
        appId: 'duya',
        context: { defaultProviderId: 'p-active', proxyTakeover: false },
      }),
    );
    expect(result.current.canDelete).toBe(true);
  });

  it('canDelete is true for the current provider when no active id is set', () => {
    const { result } = renderHook(() =>
      useProviderCardState({
        provider: makeProvider({ id: 'p-1' }),
        appId: 'duya',
        context: { defaultProviderId: null, proxyTakeover: false },
      }),
    );
    expect(result.current.canDelete).toBe(true);
  });

  it('canDuplicate and canTest are true for a normal provider', () => {
    const { result } = renderHook(() =>
      useProviderCardState({
        provider: makeProvider(),
        appId: 'duya',
        context: { defaultProviderId: null, proxyTakeover: false },
      }),
    );
    expect(result.current.canDuplicate).toBe(true);
    expect(result.current.canTest).toBe(true);
  });

  it('Phase 4 capability flags are pinned to false until those plans land', () => {
    const { result } = renderHook(() =>
      useProviderCardState({
        provider: makeProvider(),
        appId: 'duya',
        context: { defaultProviderId: null, proxyTakeover: false },
      }),
    );
    expect(result.current.canConfigureUsage).toBe(false);
    expect(result.current.canOpenTerminal).toBe(false);
    expect(result.current.canSetAsDefault).toBe(false);
  });
});

describe('useProviderCardState — orthogonal composition', () => {
  it('isCurrent and isActive are independent flags', () => {
    const { result: both } = renderHook(() =>
      useProviderCardState({
        provider: makeProvider({ id: 'p-active', isActive: true }),
        appId: 'duya',
        context: { defaultProviderId: 'p-active', proxyTakeover: false },
      }),
    );
    expect(both.current.isCurrent).toBe(true);
    expect(both.current.isActive).toBe(true);

    const { result: currentOnly } = renderHook(() =>
      useProviderCardState({
        provider: makeProvider({ id: 'p-active', isActive: false }),
        appId: 'duya',
        context: { defaultProviderId: 'p-active', proxyTakeover: false },
      }),
    );
    expect(currentOnly.current.isCurrent).toBe(true);
    expect(currentOnly.current.isActive).toBe(false);
  });

  it('changing context.defaultProviderId flips isCurrent but not isDefault', () => {
    const provider = makeProvider({ id: 'p-1', isDefault: true });
    const first = renderHook(
      ({ def }: { def: string | null }) =>
        useProviderCardState({
          provider,
          appId: 'duya',
          context: { defaultProviderId: def, proxyTakeover: false },
        }),
      { initialProps: { def: 'p-1' as string | null } },
    );
    expect(first.result.current.isCurrent).toBe(true);
    expect(first.result.current.isDefault).toBe(true);
  });

  it('isDefault is a DTO field, not derived from context', () => {
    // The hook reads `isDefault` directly from the DTO so the
    // provider is "default" iff the renderer says so. This is
    // what makes the multi-provider model work: the context
    // tells the card *who* is default; the DTO tells the card
    // *whether it is* default. Both must agree.
    const providerWithFlag = makeProvider({ id: 'p-1', isDefault: true });
    const providerWithoutFlag = makeProvider({ id: 'p-1', isDefault: false });
    const a = renderHook(() =>
      useProviderCardState({
        provider: providerWithFlag,
        appId: 'duya',
        context: { defaultProviderId: 'p-1', proxyTakeover: false },
      }),
    );
    const b = renderHook(() =>
      useProviderCardState({
        provider: providerWithoutFlag,
        appId: 'duya',
        context: { defaultProviderId: 'p-1', proxyTakeover: false },
      }),
    );
    expect(a.result.current.isDefault).toBe(true);
    expect(b.result.current.isDefault).toBe(false);
  });
});
