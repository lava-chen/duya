/**
 * @vitest-environment jsdom
 *
 * Regression tests for the windowed transcript list.
 *
 * The list mounts only the rows around the viewport, so the four behaviours
 * that depend on rows being present somewhere in the DOM have to keep
 * working:
 *
 *   - the message navigator can jump to a message that is NOT mounted,
 *   - "load earlier messages" still works,
 *   - the live tail of the transcript stays mounted while streaming,
 *   - focus mode still reaches the rows that are mounted.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, act, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import type { Message } from '@/types';

vi.mock('../MessageItem', () => ({
  MessageItem: vi.fn(({ message, focusMode }: { message: Message; focusMode?: boolean }) => (
    <div
      data-testid="message-item"
      data-message-id={message.id}
      data-focus={String(!!focusMode)}
    >
      {typeof message.content === 'string' ? message.content : 'complex-content'}
    </div>
  )),
}));

vi.mock('../StreamingMessage', () => ({
  StreamingMessage: vi.fn(() => <div data-testid="streaming-message">Streaming...</div>),
}));

vi.mock('@/hooks/useStreamingAgentProgress', () => ({
  useStreamingAgentProgress: vi.fn(() => []),
}));

import { MessageList } from '../MessageList';
import { useFocusModeStore } from '@/stores/focus-mode-store';

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
  if (!Element.prototype.scrollTo) {
    Element.prototype.scrollTo = vi.fn();
  }
  global.ResizeObserver = vi.fn().mockImplementation(function () {
    return {
      observe: vi.fn(),
      disconnect: vi.fn(),
    };
  });
  useFocusModeStore.setState({ enabledBySession: {} });
});

const SESSION_ID = 'session-windowing';

function userMessages(count: number): Message[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `msg-${index}`,
    role: 'user' as const,
    content: `question ${index}`,
    timestamp: 1_700_000_000_000 + index * 1_000,
  }));
}

/** The rows the list has in the DOM, by message id. */
function mountedRowIds(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll('[data-message-id]'))
    .map((node) => node.getAttribute('data-message-id') ?? '');
}

describe('windowed transcript list', () => {
  it('mounts only a part of the transcript', () => {
    const { container } = render(
      <MessageList messages={userMessages(200)} sessionId={SESSION_ID} />,
    );

    const mounted = mountedRowIds(container);
    // The whole transcript is NOT in the DOM any more.
    expect(mounted.length).toBeLessThan(60);
    // The tail is mounted: the live tail of the transcript must never be
    // replaced by a spacer.
    expect(mounted).toContain('msg-199');
  });

  it('jumps to a message that is not mounted', async () => {
    const { container } = render(
      <MessageList messages={userMessages(40)} sessionId={SESSION_ID} />,
    );

    // The middle of the transcript is not mounted before the jump.
    expect(container.querySelector('#message-row-session-windowing-msg-20')).toBeNull();

    // Pick a navigator dot whose turn is NOT mounted. The rail only renders a
    // capped number of dots, so the dot to click is looked up, not assumed.
    const dots = screen.getAllByRole('button', { name: /^Jump to message \d+$/ });
    const target = dots.find((dot) => {
      const index = Number.parseInt(dot.getAttribute('aria-label')?.replace(/\D+/g, '') ?? '0', 10) - 1;
      return !container.querySelector(`#message-row-session-windowing-msg-${index}`);
    });
    expect(target).toBeDefined();
    const targetIndex = Number.parseInt(
      target?.getAttribute('aria-label')?.replace(/\D+/g, '') ?? '0',
      10,
    ) - 1;

    await act(async () => {
      fireEvent.click(target as HTMLElement);
    });

    // The jump mounts the target, so the row is on screen.
    expect(container.querySelector(`#message-row-session-windowing-msg-${targetIndex}`)).not.toBeNull();
    // The rows the jump scrolled past are replaced by a spacer, not dropped:
    // the scroll height of the transcript stays the same.
    const mounted = mountedRowIds(container);
    expect(mounted).toContain(`msg-${targetIndex}`);
    expect(mounted).toContain('msg-39');
    const spacer = container.querySelector('div[aria-hidden="true"][style*="height"]');
    expect(spacer).not.toBeNull();
    expect(Number.parseFloat((spacer as HTMLElement).style.height)).toBeGreaterThan(0);
  });

  it('caps the navigator rail instead of rendering one dot per turn', () => {
    render(<MessageList messages={userMessages(400)} sessionId={SESSION_ID} />);

    const dots = screen.getAllByRole('button', { name: /^Jump to message \d+$/ });
    // The rail is designed for MAX_VISIBLE_DOTS dots; one dot per turn made
    // the rail 156 000px tall on a 10 000 message session.
    expect(dots.length).toBeGreaterThan(0);
    expect(dots.length).toBeLessThanOrEqual(21);
  });

  it('keeps the "load earlier messages" button working', async () => {
    const onLoadMore = vi.fn();
    render(
      <MessageList
        messages={userMessages(40)}
        sessionId={SESSION_ID}
        hasMore
        onLoadMore={onLoadMore}
      />,
    );

    const button = screen.getByRole('button', { name: /load earlier messages/i });
    await act(async () => {
      fireEvent.click(button);
    });

    expect(onLoadMore).toHaveBeenCalledTimes(1);
  });

  it('keeps the streaming tail mounted', () => {
    const { container } = render(
      <MessageList
        messages={userMessages(200)}
        sessionId={SESSION_ID}
        isStreaming
      />,
    );

    // The live tail is mounted even though the viewport is at the top.
    expect(container.querySelector('#message-row-session-windowing-msg-199')).not.toBeNull();
    expect(screen.getByTestId('streaming-message')).toBeInTheDocument();
  });

  it('passes focus mode to the mounted rows', () => {
    useFocusModeStore.getState().setEnabled(SESSION_ID, true);

    render(<MessageList messages={userMessages(40)} sessionId={SESSION_ID} />);

    const items = screen.getAllByTestId('message-item');
    expect(items.length).toBeGreaterThan(0);
    expect(items.every((item) => item.getAttribute('data-focus') === 'true')).toBe(true);
  });
});
