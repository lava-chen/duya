import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { usePopoverPlacement, toFloatingPlacement } from './usePopoverPlacement';

// @floating-ui/react reads from viewport via Element APIs that jsdom does not
// implement accurately. We only assert the public contract:
//   - placement starts at the preferred value
//   - reference ref accepts HTMLElement | null
//   - style object uses `position: fixed` so callers escape overflow:hidden
//   - toFloatingPlacement converts legacy spellings

describe('usePopoverPlacement', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('starts at the preferred placement', () => {
    const { result } = renderHook(() =>
      usePopoverPlacement({ placement: 'bottom-end' }),
    );
    expect(result.current.placement).toBe('bottom-end');
    expect(result.current.style.position).toBe('fixed');
  });

  it('exposes a ref setter that accepts a node then null without throwing', () => {
    const { result } = renderHook(() =>
      usePopoverPlacement({ placement: 'top' }),
    );

    const fakeAnchor = document.createElement('button');
    const fakePopover = document.createElement('div');

    act(() => {
      result.current.ref(fakeAnchor);
      result.current.popoverRef(fakePopover);
    });
    act(() => {
      result.current.ref(null);
      result.current.popoverRef(null);
    });

    expect(result.current.style).toBeDefined();
    expect(typeof result.current.style).toBe('object');
  });

  it('respects offsetPx by carrying it through options', () => {
    // We cannot read floating-ui's internal middleware list, but we can
    // assert that the hook accepts the option without throwing — the
    // option list is the public contract documented in the JSDoc.
    const { result } = renderHook(() =>
      usePopoverPlacement({ placement: 'left', offsetPx: 16 }),
    );
    expect(result.current.placement).toBe('left');
  });
});

describe('toFloatingPlacement', () => {
  it.each([
    ['above', 'top'],
    ['above-start', 'top-start'],
    ['above-end', 'top-end'],
    ['below', 'bottom'],
    ['below-start', 'bottom-start'],
    ['below-end', 'bottom-end'],
  ] as const)('maps %s → %s', (legacy, modern) => {
    expect(toFloatingPlacement(legacy)).toBe(modern);
  });
});
