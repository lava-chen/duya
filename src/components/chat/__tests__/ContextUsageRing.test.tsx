/**
 * ContextUsageRing.test.tsx - hover-expand + click-to-pin interaction tests.
 *
 * The stats line opens on hover (with a 150ms close grace period) and a
 * single click on the ring pins it open; unpin via second click, outside
 * mousedown, or Escape.
 *
 * @vitest-environment jsdom
 */

import { act, fireEvent, render } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ContextUsageRing } from '../ContextUsageRing';

const HIDE_DELAY_MS = 150;

function renderRing() {
  const view = render(<ContextUsageRing messages={[]} />);
  const wrap = view.container.querySelector(
    '.context-usage-ring-wrap',
  ) as HTMLElement | null;
  const shell = view.container.querySelector(
    '.context-usage-ring-stats-shell',
  ) as HTMLElement | null;
  const trigger = view.getByRole('button', { name: 'Context usage' });
  if (!wrap || !shell) throw new Error('ring structure missing');
  return { view, wrap, shell, trigger };
}

/** Pin the ring: hover in + click, then hover out so only `pinned` holds it open. */
function pinAndLeave(wrap: HTMLElement, trigger: HTMLElement) {
  fireEvent.mouseEnter(wrap);
  fireEvent.click(trigger);
  fireEvent.mouseLeave(wrap);
  // Advance past the hide delay — pinned keeps the line open anyway.
  act(() => {
    vi.advanceTimersByTime(HIDE_DELAY_MS + 50);
  });
}

describe('ContextUsageRing', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('starts collapsed', () => {
    const { shell } = renderRing();
    expect(shell.getAttribute('aria-hidden')).toBe('true');
  });

  it('expands on hover and collapses after the hide delay', () => {
    const { wrap, shell } = renderRing();
    fireEvent.mouseEnter(wrap);
    expect(shell.getAttribute('aria-hidden')).toBe('false');
    fireEvent.mouseLeave(wrap);
    // Grace period: still visible immediately after leave.
    expect(shell.getAttribute('aria-hidden')).toBe('false');
    act(() => {
      vi.advanceTimersByTime(HIDE_DELAY_MS + 50);
    });
    expect(shell.getAttribute('aria-hidden')).toBe('true');
  });

  it('click pins the stats line open across mouse-leave', () => {
    const { wrap, shell, trigger } = renderRing();
    pinAndLeave(wrap, trigger);
    expect(trigger.getAttribute('aria-pressed')).toBe('true');
    expect(shell.getAttribute('aria-hidden')).toBe('false');
  });

  it('second click unpins and lets the line collapse', () => {
    const { wrap, shell, trigger } = renderRing();
    pinAndLeave(wrap, trigger);
    fireEvent.click(trigger);
    expect(trigger.getAttribute('aria-pressed')).toBe('false');
    // Not hovering anymore, so it collapses right away.
    expect(shell.getAttribute('aria-hidden')).toBe('true');
  });

  it('outside mousedown does not unpin — only a ring click does', () => {
    const { wrap, shell, trigger } = renderRing();
    pinAndLeave(wrap, trigger);
    fireEvent.mouseDown(document.body);
    expect(shell.getAttribute('aria-hidden')).toBe('false');
  });

  it('Escape does not unpin — only a ring click does', () => {
    const { wrap, shell, trigger } = renderRing();
    pinAndLeave(wrap, trigger);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(shell.getAttribute('aria-hidden')).toBe('false');
  });

  it('keyboard Enter toggles pin', () => {
    const { wrap, shell, trigger } = renderRing();
    fireEvent.mouseEnter(wrap);
    fireEvent.keyDown(trigger, { key: 'Enter' });
    fireEvent.mouseLeave(wrap);
    vi.advanceTimersByTime(HIDE_DELAY_MS + 50);
    expect(trigger.getAttribute('aria-pressed')).toBe('true');
    expect(shell.getAttribute('aria-hidden')).toBe('false');
  });

  // popup variant (bot composer): hover opens the stats CARD instead of
  // the slide-out line; no data yet → "?" placeholder row.
  it('popup variant: shows the stats card on hover and hides it on leave', () => {
    const view = render(<ContextUsageRing messages={[]} variant="popup" />);
    const wrap = view.container.querySelector(
      '.context-usage-ring-wrap',
    ) as HTMLElement | null;
    const popover = view.container.querySelector(
      '.context-usage-popover',
    ) as HTMLElement | null;
    if (!wrap || !popover) throw new Error('popup structure missing');
    // No slide-out line in popup mode.
    expect(
      view.container.querySelector('.context-usage-ring-stats-shell'),
    ).toBeNull();

    expect(popover.getAttribute('aria-hidden')).toBe('true');
    fireEvent.mouseEnter(wrap);
    expect(popover.getAttribute('aria-hidden')).toBe('false');
    expect(popover.textContent).toContain('Context');
    expect(popover.textContent).toContain('?');

    fireEvent.mouseLeave(wrap);
    act(() => {
      vi.advanceTimersByTime(HIDE_DELAY_MS + 50);
    });
    expect(popover.getAttribute('aria-hidden')).toBe('true');
  });
});
