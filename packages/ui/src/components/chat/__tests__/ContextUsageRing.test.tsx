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
import { ContextUsageRing, ContextUsagePanel } from '../ContextUsageRing';

const HIDE_DELAY_MS = 150;

function renderRing() {
  const view = render(<ContextUsageRing messages={[]} />);
  const wrap = view.container.querySelector(
    '.context-usage-ring-wrap',
  ) as HTMLElement | null;
  const shell = view.container.querySelector(
    '.context-usage-ring-stats-shell',
  ) as HTMLElement | null;
  const breakdown = view.container.querySelector(
    '.context-composition-popover',
  ) as HTMLElement | null;
  const trigger = view.getByRole('button', { name: 'Context usage' });
  if (!wrap || !shell || !breakdown) throw new Error('ring structure missing');
  return { view, wrap, shell, breakdown, trigger };
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
    const { wrap, shell, breakdown } = renderRing();
    fireEvent.mouseEnter(wrap);
    // Hovering the ring opens the COMPOSITION BREAKDOWN popover
    // (showBreakdown = hovered && !pinned && …), and while that is showing the
    // slide-out stats line is deliberately suppressed
    // (statsExpanded = … && !showBreakdown). They are two distinct surfaces;
    // the breakdown is the one hover reveals.
    expect(breakdown.getAttribute('aria-hidden')).toBe('false');
    expect(shell.getAttribute('aria-hidden')).toBe('true');

    fireEvent.mouseLeave(wrap);
    // Grace period: still visible immediately after leave.
    expect(breakdown.getAttribute('aria-hidden')).toBe('false');
    act(() => {
      vi.advanceTimersByTime(HIDE_DELAY_MS + 50);
    });
    expect(breakdown.getAttribute('aria-hidden')).toBe('true');
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
  it('popup variant: shows the composition breakdown on hover and hides it on leave', () => {
    const view = render(<ContextUsageRing messages={[]} variant="popup" />);
    const wrap = view.container.querySelector(
      '.context-usage-ring-wrap',
    ) as HTMLElement | null;
    // In popup mode the hovered surface is the composition breakdown
    // (.context-composition-popover); the .context-usage-popover stats card is
    // gated on statsExpanded, which is suppressed while the breakdown shows.
    const breakdown = view.container.querySelector(
      '.context-composition-popover',
    ) as HTMLElement | null;
    if (!wrap || !breakdown) throw new Error('popup structure missing');

    expect(breakdown.getAttribute('aria-hidden')).toBe('true');
    fireEvent.mouseEnter(wrap);
    expect(breakdown.getAttribute('aria-hidden')).toBe('false');
    // No data yet → "?" placeholder rather than a fabricated number.
    expect(breakdown.textContent).toContain('?');

    fireEvent.mouseLeave(wrap);
    act(() => {
      vi.advanceTimersByTime(HIDE_DELAY_MS + 50);
    });
    expect(breakdown.getAttribute('aria-hidden')).toBe('true');
  });

  // panel variant (chat composer): the ring is a bare controlled trigger —
  // no stats of its own; the parent renders <ContextUsagePanel> below the
  // composer and flips its `open` state.
  it('panel variant: click delegates to onToggle and reflects controlled state', () => {
    const onToggle = vi.fn();
    const view = render(
      <ContextUsageRing
        messages={[]}
        variant="panel"
        expanded={false}
        onToggle={onToggle}
      />,
    );
    const trigger = view.getByRole('button', { name: 'Context usage' });
    // No slide-out line and no popup — the stats live in the sibling panel.
    expect(
      view.container.querySelector('.context-usage-ring-stats-shell'),
    ).toBeNull();
    expect(view.container.querySelector('.context-usage-popover')).toBeNull();
    expect(trigger.getAttribute('aria-pressed')).toBe('false');

    fireEvent.click(trigger);
    expect(onToggle).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(trigger, { key: 'Enter' });
    expect(onToggle).toHaveBeenCalledTimes(2);

    // Controlled: parent flips `expanded`, the trigger mirrors it.
    view.rerender(
      <ContextUsageRing
        messages={[]}
        variant="panel"
        expanded={true}
        onToggle={onToggle}
      />,
    );
    expect(trigger.getAttribute('aria-pressed')).toBe('true');
  });

  it('ContextUsagePanel: closed reserves no content visibility, open shows stats', () => {
    const onCompress = vi.fn();
    const view = render(
      <ContextUsagePanel
        messages={[]}
        open={false}
        onCompress={onCompress}
      />,
    );
    const shell = view.container.querySelector(
      '.context-usage-panel-shell',
    ) as HTMLElement;
    expect(shell.getAttribute('data-open')).toBe('false');
    expect(shell.getAttribute('aria-hidden')).toBe('true');

    view.rerender(
      <ContextUsagePanel
        messages={[]}
        open={true}
        onCompress={onCompress}
      />,
    );
    expect(shell.getAttribute('data-open')).toBe('true');
    expect(shell.getAttribute('aria-hidden')).toBe('false');
    // No usage data anywhere → "?" placeholder instead of a fake number.
    const panel = view.container.querySelector(
      '.context-usage-panel',
    ) as HTMLElement;
    expect(panel.textContent).toContain('?');
  });
});
