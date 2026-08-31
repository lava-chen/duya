// @vitest-environment jsdom
/**
 * src/components/providers/__tests__/useQuotaNavigation.test.ts
 *
 * Plan 204 Phase 5.1: verifies the navigation callback
 * delegates to `useConversationStore.setSettingsTab('usage')`.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

const setSettingsTab = vi.fn();
vi.mock('@/stores/conversation-store', () => ({
  useConversationStore: (selector: (s: { setSettingsTab: typeof setSettingsTab }) => unknown) =>
    selector({ setSettingsTab }),
}));

import { useQuotaNavigation } from '../hooks/useQuotaNavigation';

describe('useQuotaNavigation', () => {
  beforeEach(() => {
    setSettingsTab.mockReset();
  });

  it('returns a stable callback across re-renders', () => {
    const { result, rerender } = renderHook(() => useQuotaNavigation());
    const first = result.current;
    rerender();
    const second = result.current;
    expect(first).toBe(second);
  });

  it('invokes setSettingsTab with "usage" when called', () => {
    const { result } = renderHook(() => useQuotaNavigation());
    act(() => {
      result.current();
    });
    expect(setSettingsTab).toHaveBeenCalledTimes(1);
    expect(setSettingsTab).toHaveBeenCalledWith('usage');
  });
});
