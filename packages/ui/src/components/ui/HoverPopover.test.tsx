/**
 * @vitest-environment jsdom
 *
 * HoverPopover renders through a portal into document.body and drives
 * hover/focus state with real events, so it needs a DOM. The file was
 * picking up the global `environment: 'node'` default from
 * vitest.config.ts and every case died on `document is not defined`
 * before reaching an assertion.
 */
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HoverPopover } from './HoverPopover';

describe('HoverPopover', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders the trigger but no popover before hover', () => {
    render(
      <HoverPopover content={<span>body</span>}>
        <button>anchor</button>
      </HoverPopover>,
    );

    expect(screen.getByRole('button', { name: 'anchor' })).toBeTruthy();
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it('opens after mouseenter and portals the popover to document.body', () => {
    render(
      <HoverPopover content={<span>popover body</span>}>
        <button>anchor</button>
      </HoverPopover>,
    );

    const wrapper = screen.getByRole('button', { name: 'anchor' }).parentElement;
    expect(wrapper).toBeTruthy();

    act(() => {
      fireEvent.mouseEnter(wrapper!);
    });

    const popover = screen.getByRole('tooltip');
    expect(popover).toBeTruthy();
    // The popover renders INLINE as a direct child of the relative wrapper,
    // not portaled to <body>. The earlier portal was deliberately reverted:
    // portaling detached the popover from the wrapper's hover region, so the
    // cursor lost hover crossing the 10px placement gap and the popover
    // closed before it could be reached. Inline keeps the gap traversable and
    // the absolute positioning anchored to the trigger.
    expect(popover.parentElement).toBe(wrapper);
    expect(popover.textContent).toContain('popover body');
  });

  it('respects disabled and never opens', () => {
    render(
      <HoverPopover content={<span>body</span>} disabled>
        <button>anchor</button>
      </HoverPopover>,
    );

    const wrapper = screen.getByRole('button', { name: 'anchor' }).parentElement;
    act(() => {
      fireEvent.mouseEnter(wrapper!);
    });
    expect(screen.queryByRole('tooltip')).toBeNull();
  });
});
