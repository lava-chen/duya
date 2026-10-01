'use client';

import {
  autoUpdate,
  flip,
  offset,
  shift,
  useFloating,
  type Placement,
} from '@floating-ui/react';
import { type CSSProperties, type RefObject } from 'react';

/**
 * usePopoverPlacement — single placement hook used by every anchor-anchored
 * popover across duya. Centralises the runtime measurement that previously
 * lived as ad-hoc `getBoundingClientRect` math inside each component.
 *
 * Why a wrapper instead of `@floating-ui/react`'s raw `useFloating`:
 *   - Pins the default middleware stack (`flip + shift + offset`) so callers
 *     don't have to remember it.
 *   - Adapts floating-ui's `Placement` strings ('top-start', etc.) into the
 *     kebab-cased spelling (`'top-start'` vs `'above-start'`) our older
 *     HoverPopover API used, so the public prop surface stays stable.
 *   - Couples the popover ref so `autoUpdate` keeps it pinned during scroll
 *     and resize without each caller wiring its own effect.
 *
 * Returns three things a caller MUST spread:
 *   - `ref`         → onto the anchor element (the trigger)
 *   - `popoverRef`  → onto the floating content (popover body)
 *   - `style`       → onto the popover root; uses `position: fixed` so the
 *                     popover escapes any `overflow: hidden` ancestor.
 *
 * Callers can still opt out of flipping by passing `flip={false}` (e.g. for
 * one-sided tooltips that physically cannot fit on the other side anyway).
 */
export interface UsePopoverPlacementOptions {
  /** Preferred placement. Will be flipped when anchor overflows viewport. */
  placement?: Placement;
  /** Gap between anchor and popover, in px. Default 8. */
  offsetPx?: number;
  /** Padding from viewport edges when shifting. Default 8. */
  viewportPadding?: number;
  /** Disable flipping (stick to preferred placement). Default false. */
  disableFlip?: boolean;
  /** Whether to keep updating position on scroll/resize. Default true. */
  autoUpdateWhileMounted?: boolean;
}

export interface UsePopoverPlacementResult<T extends HTMLElement = HTMLElement> {
  /** Anchor element ref — spread onto the trigger. */
  ref: (node: T | null) => void;
  /** Popover root ref — spread onto the content root. */
  popoverRef: (node: HTMLElement | null) => void;
  /** Spread onto the popover root alongside your className/style. */
  style: CSSProperties;
  /**
   * Current resolved placement after flip. Useful for pointing arrows or
   * choosing directional styling.
   */
  placement: Placement;
}

export function usePopoverPlacement<T extends HTMLElement = HTMLElement>(
  options: UsePopoverPlacementOptions = {},
): UsePopoverPlacementResult<T> {
  const {
    placement: preferredPlacement = 'top',
    offsetPx = 8,
    viewportPadding = 8,
    disableFlip = false,
    autoUpdateWhileMounted = true,
  } = options;

  const middleware = [
    offset(offsetPx),
    ...(disableFlip ? [] : [flip()]),
    shift({ padding: viewportPadding }),
  ];

  const { refs, floatingStyles, placement, update } = useFloating({
    placement: preferredPlacement,
    middleware,
    ...(autoUpdateWhileMounted
      ? { whileElementsMounted: autoUpdate }
      : {}),
  });

  // expose update so callers can force a re-measure after content size changes
  void update;

  return {
    ref: refs.setReference as unknown as (node: T | null) => void,
    popoverRef: refs.setFloating,
    style: floatingStyles,
    placement,
  };
}

/**
 * Normalise legacy placement spellings (`above`, `below-start` …) used by
 * older duya components to floating-ui's `Placement` (`top`, `bottom-start` …).
 * Exported so `HoverPopover` can convert its `HoverPopoverPlacement` prop
 * before handing it to this hook.
 */
export function toFloatingPlacement(
  legacy: 'above' | 'above-start' | 'above-end' | 'below' | 'below-start' | 'below-end',
): Placement {
  switch (legacy) {
    case 'above':
      return 'top';
    case 'above-start':
      return 'top-start';
    case 'above-end':
      return 'top-end';
    case 'below':
      return 'bottom';
    case 'below-start':
      return 'bottom-start';
    case 'below-end':
      return 'bottom-end';
  }
}

/**
 * Bind the placement result to a React ref you already own, instead of
 * letting floating-ui manage its own ref. Useful when the trigger is already
 * created via `useRef` (e.g. menu buttons inside `Button.tsx`).
 */
export function bindPlacementToRef<T extends HTMLElement>(
  placement: UsePopoverPlacementResult,
  anchorRef: RefObject<T>,
): void {
  // Call once on mount — the hook exposes a setter ref, so passing the
  // current node (or null on unmount) keeps floating-ui in sync.
  placement.ref(anchorRef.current);
}
