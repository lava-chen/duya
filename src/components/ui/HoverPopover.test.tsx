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
    // After the auto-flip upgrade the popover is portaled to <body>, not
    // nested inside the wrapper. This is what lets fixed-positioned
    // floating-ui coordinates escape `overflow: hidden` ancestors.
    expect(popover.parentElement).toBe(document.body);
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
