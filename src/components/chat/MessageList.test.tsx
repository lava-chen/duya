/**
 * @vitest-environment jsdom
 */

/**
 * MessageList - Unit Tests
 *
 * Tests the message list component rendering:
 * - Message rendering for user and assistant messages
 * - Streaming message display when isStreaming is true
 * - Error display
 * - "Load earlier messages" button when hasMore is true
 * - Empty state (no messages)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import type { Message } from '@/types';

// Mock all child components to isolate MessageList
vi.mock('./MessageItem', () => ({
  MessageItem: vi.fn(({ message }: { message: Message }) => (
    <div data-testid="message-item" data-message-id={message.id} data-role={message.role}>
      {typeof message.content === 'string' ? message.content : 'complex-content'}
    </div>
  )),
}));

vi.mock('./StreamingMessage', () => ({
  StreamingMessage: vi.fn(({ isFinalizing }: { isFinalizing?: boolean }) => (
    <div data-testid="streaming-message" data-finalizing={String(!!isFinalizing)}>Streaming...</div>
  )),
}));

vi.mock('@/hooks/useStreamingAgentProgress', () => ({
  useStreamingAgentProgress: vi.fn(() => []),
}));

import { MessageList } from './MessageList';

// Mock scrollIntoView since JSDOM doesn't support it
beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
  // JSDOM does not implement scrollTo on HTMLDivElement — the smooth-scroll
  // code path in MessageList uses it; stub it so handler clicks don't throw.
  if (!Element.prototype.scrollTo) {
    Element.prototype.scrollTo = vi.fn();
  }
  global.ResizeObserver = vi.fn().mockImplementation(() => ({
    observe: vi.fn(),
    disconnect: vi.fn(),
  }));
  // Force rAF to run synchronously so the scroll-state observer's
  // `requestAnimationFrame(() => updateScrollState())` resolves inside the
  // test body. Without this JSDOM's rAF only fires when `_pretendToBeVisual`
  // is set, and `isScrolledUp` never flips to true after we dispatch `scroll`.
  // Use a typed `g` alias for the JSDOM `globalThis` — TS strict mode
  // rejects `globalThis.requestAnimationFrame` because `globalThis` has no
  // index signature, and using `as unknown as ...` cascades into "this
  // expression is not callable" downstream. A local `g` with a precise
  // interface keeps the cast narrow and explicit.
  interface JSDOMGlobals {
    requestAnimationFrame?: (cb: FrameRequestCallback) => number;
    __duyaTestRafStubbed?: boolean;
  }
  const g = globalThis as unknown as JSDOMGlobals;
  if (g.requestAnimationFrame && !g.__duyaTestRafStubbed) {
    g.requestAnimationFrame = (cb: FrameRequestCallback) => {
      cb(performance.now());
      return 0;
    };
    g.__duyaTestRafStubbed = true;
  }
});

function createMockMessage(overrides: Partial<Message> = {}): Message {
  return {
    id: 'msg-1',
    role: 'user',
    content: 'Hello world',
    timestamp: Date.now(),
    ...overrides,
  };
}

describe('MessageList', () => {
  // =========================================================================
  // Basic Rendering
  // =========================================================================

  describe('basic rendering', () => {
    it('renders without crashing with empty messages', () => {
      const { container } = render(
        <MessageList messages={[]} sessionId="session-1" />
      );
      expect(container).toBeTruthy();
    });

    it('renders user message', () => {
      const messages: Message[] = [
        createMockMessage({ id: 'user-1', role: 'user', content: 'Hello' }),
      ];
      render(<MessageList messages={messages} sessionId="session-1" />);

      const items = screen.getAllByTestId('message-item');
      expect(items).toHaveLength(1);
      expect(items[0]).toHaveAttribute('data-role', 'user');
    });

    it('renders assistant message', () => {
      const messages: Message[] = [
        createMockMessage({ id: 'asst-1', role: 'assistant', content: 'I am an AI' }),
      ];
      render(<MessageList messages={messages} sessionId="session-1" />);

      const items = screen.getAllByTestId('message-item');
      expect(items).toHaveLength(1);
      expect(items[0]).toHaveAttribute('data-role', 'assistant');
    });

    it('renders multiple messages in correct order', () => {
      const messages: Message[] = [
        createMockMessage({ id: 'u1', role: 'user', content: 'Hello' }),
        createMockMessage({ id: 'a1', role: 'assistant', content: 'Hi!' }),
        createMockMessage({ id: 'u2', role: 'user', content: 'How are you?' }),
        createMockMessage({ id: 'a2', role: 'assistant', content: 'Great!' }),
      ];
      render(<MessageList messages={messages} sessionId="session-1" />);

      const items = screen.getAllByTestId('message-item');
      expect(items).toHaveLength(4);
    });

    it('uses seqIndex to keep completed assistant output with its original user turn', () => {
      const messages: Message[] = [
        createMockMessage({ id: 'u1', role: 'user', content: 'First prompt', timestamp: 1000, seqIndex: 100 }),
        createMockMessage({ id: 'u2', role: 'user', content: 'Second prompt', timestamp: 3000, seqIndex: 200 }),
        createMockMessage({ id: 'a1', role: 'assistant', content: 'First answer', timestamp: 4000, seqIndex: 100 }),
      ];
      render(<MessageList messages={messages} sessionId="session-1" />);

      const items = screen.getAllByTestId('message-item');
      expect(items.map((item) => item.getAttribute('data-message-id'))).toEqual(['u1', 'a1', 'u2']);
    });
  });

  // =========================================================================
  // Streaming
  // =========================================================================

  describe('streaming', () => {
    it('shows streaming message when isStreaming is true', () => {
      render(
        <MessageList messages={[]} isStreaming={true} sessionId="session-1" />
      );

      expect(screen.getByTestId('streaming-message')).toBeTruthy();
    });

    it('does not show streaming message when isStreaming is false', () => {
      render(
        <MessageList messages={[]} isStreaming={false} sessionId="session-1" />
      );

      expect(screen.queryByTestId('streaming-message')).toBeNull();
    });

    it('keeps the transient stream view marked as finalizing during the DB handoff', () => {
      render(
        <MessageList messages={[]} isStreaming={true} isFinalizing={true} sessionId="session-1" />
      );

      expect(screen.getByTestId('streaming-message')).toHaveAttribute('data-finalizing', 'true');
    });
  });

  // =========================================================================
  // Error Display
  // =========================================================================

  describe('error display', () => {
    it('shows error when error prop is provided', () => {
      render(
        <MessageList
          messages={[]}
          sessionId="session-1"
          error="Something went wrong"
        />
      );

      expect(screen.getByText('Error')).toBeTruthy();
      expect(screen.getByText('Something went wrong')).toBeTruthy();
    });

    it('does not show error when error prop is null', () => {
      render(
        <MessageList messages={[]} sessionId="session-1" error={null} />
      );

      expect(screen.queryByText('Error')).toBeNull();
    });

    it('does not show error when error prop is undefined', () => {
      render(
        <MessageList messages={[]} sessionId="session-1" />
      );

      expect(screen.queryByText('Error')).toBeNull();
    });
  });

  // =========================================================================
  // Load More
  // =========================================================================

  describe('load more', () => {
    it('shows "Load earlier messages" button when hasMore is true', () => {
      render(
        <MessageList messages={[]} hasMore={true} sessionId="session-1" />
      );

      expect(screen.getByText('Load earlier messages')).toBeTruthy();
    });

    it('does not show "Load earlier messages" button when hasMore is false', () => {
      render(
        <MessageList messages={[]} hasMore={false} sessionId="session-1" />
      );

      expect(screen.queryByText('Load earlier messages')).toBeNull();
    });
  });

  // =========================================================================
  // Session ID
  // =========================================================================

  describe('session handling', () => {
    it('renders correctly with sessionId prop', () => {
      const { container } = render(
        <MessageList
          messages={[
            createMockMessage({ id: 'u1', role: 'user', content: 'Test' }),
          ]}
          sessionId="test-session-123"
        />
      );
      expect(container).toBeTruthy();
    });
  });

  // =========================================================================
  // Edge Cases
  // =========================================================================

  describe('edge cases', () => {
    it('handles large number of messages', () => {
      const messages: Message[] = Array.from({ length: 100 }, (_, i) =>
        createMockMessage({
          id: `msg-${i}`,
          role: i % 2 === 0 ? 'user' : 'assistant',
          content: `Message ${i}`,
          timestamp: Date.now() - (100 - i) * 1000,
        })
      );

      render(<MessageList messages={messages} sessionId="session-1" />);
      // Should render without crashing
      expect(screen.getAllByTestId('message-item').length).toBeGreaterThan(0);
    });

    it('hides empty assistant placeholders that would otherwise render timestamp-only rows', () => {
      const messages: Message[] = [
        createMockMessage({ id: 'empty', role: 'assistant', content: '' }),
      ];
      render(<MessageList messages={messages} sessionId="session-1" />);

      expect(screen.queryByTestId('message-item')).toBeNull();
    });
  });

  // =========================================================================
  // Plan 532 — scroll behaviour parity with BotDirectChatView
  // (jump-to-latest on freeze, no scrollIntoView yank on new user messages,
  //  jump-to-latest clears the unread badge).
  // =========================================================================

  describe('scroll behaviour (plan 532)', () => {
    function getScrollContainer(container: HTMLElement): HTMLDivElement {
      // The outermost scroll element is `.message-list-scroll`.
      const scrollEl = container.querySelector('.message-list-scroll');
      if (!(scrollEl instanceof HTMLDivElement)) {
        throw new Error('Expected .message-list-scroll container');
      }
      return scrollEl;
    }

    /**
     * Install `clientHeight` / `scrollHeight` properties on every
     * `.message-list-scroll` element. Use this BEFORE `render(...)` so the
     * mount useLayoutEffect observes the right dimensions. Also works
     * afterwards, because we re-apply to the freshly-mounted container.
     */
    function stubContainerHeights(): () => void {
      const original = Object.getOwnPropertyDescriptor(
        HTMLElement.prototype,
        'clientHeight'
      );
      Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
        configurable: true,
        get: () => 400,
      });
      Object.defineProperty(HTMLElement.prototype, 'scrollHeight', {
        configurable: true,
        get: () => 2400,
      });
      return () => {
        if (original) {
          Object.defineProperty(HTMLElement.prototype, 'clientHeight', original);
        }
      };
    }

    it('mounts with scroll pinned to the bottom on the first paint', () => {
      const restore = stubContainerHeights();
      try {
        const messages: Message[] = [
          createMockMessage({ id: 'u1', role: 'user', content: 'hi' }),
          createMockMessage({ id: 'a1', role: 'assistant', content: 'hello' }),
        ];

        const { container } = render(
          <MessageList messages={messages} sessionId="session-1" />
        );

        const scrollEl = getScrollContainer(container);

        // The synchronous useLayoutEffect runs scrollTop = scrollHeight.
        expect(scrollEl.scrollTop).toBe(scrollEl.scrollHeight);
      } finally {
        restore();
      }
    });

    it('does not call scrollIntoView when the user sends a message while pinned to the bottom', () => {
      const restore = stubContainerHeights();
      try {
        const initial: Message[] = [
          createMockMessage({ id: 'u1', role: 'user', content: 'hi' }),
        ];
        const { container, rerender } = render(
          <MessageList messages={initial} sessionId="session-1" />
        );
        const scrollEl = getScrollContainer(container);
        scrollEl.scrollTop = scrollEl.scrollHeight; // pin user to bottom
        const scrollIntoViewSpy = Element.prototype.scrollIntoView as unknown as ReturnType<typeof vi.fn>;
        scrollIntoViewSpy.mockClear();

        const next: Message[] = [
          ...initial,
          createMockMessage({ id: 'u2', role: 'user', content: 'another question' }),
        ];
        rerender(<MessageList messages={next} sessionId="session-1" />);

        // Plan 532: scrollIntoView must not be used to "rescue" the viewport
        // when the user is at the bottom. We only call scrollTop = scrollHeight.
        expect(scrollIntoViewSpy).not.toHaveBeenCalled();
      } finally {
        restore();
      }
    });

    it('does not call scrollIntoView when a message arrives while the user is scrolled away', async () => {
      const restore = stubContainerHeights();
      try {
        const initial: Message[] = [
          createMockMessage({ id: 'u1', role: 'user', content: 'hi' }),
        ];
        const { container, rerender } = render(
          <MessageList messages={initial} sessionId="session-1" />
        );
        const scrollEl = getScrollContainer(container);

        // User scrolls away from the bottom.
        await act(async () => {
          scrollEl.scrollTop = 50;
          scrollEl.dispatchEvent(new Event('scroll'));
        });

        const scrollIntoViewSpy = Element.prototype.scrollIntoView as unknown as ReturnType<typeof vi.fn>;
        scrollIntoViewSpy.mockClear();

        const next: Message[] = [
          ...initial,
          createMockMessage({ id: 'a1', role: 'assistant', content: 'reply' }),
        ];
        rerender(<MessageList messages={next} sessionId="session-1" />);

        // Plan 532: never yank the viewport back. The user has the jump-to-
        // latest button to come back on their own terms.
        expect(scrollIntoViewSpy).not.toHaveBeenCalled();
      } finally {
        restore();
      }
    });

    it('renders the jump-to-latest button with an unread badge after the user is scrolled away and a new turn lands', async () => {
      const restore = stubContainerHeights();
      try {
        const initial: Message[] = [
          createMockMessage({ id: 'u1', role: 'user', content: 'hi' }),
        ];
        const { container, rerender } = render(
          <MessageList messages={initial} sessionId="session-1" />
        );
        const scrollEl = getScrollContainer(container);
        // Scroll away so isScrolledUp flips to true on the next render.
        // Wrap the scroll dispatch in act so the rAF-scheduled state update
        // is flushed before we assert.
        await act(async () => {
          scrollEl.scrollTop = 50;
          scrollEl.dispatchEvent(new Event('scroll'));
        });

        const next: Message[] = [
          ...initial,
          createMockMessage({ id: 'a1', role: 'assistant', content: 'reply' }),
        ];
        rerender(<MessageList messages={next} sessionId="session-1" />);

        const next2: Message[] = [
          ...next,
          createMockMessage({ id: 'u2', role: 'user', content: 'another question' }),
        ];
        rerender(<MessageList messages={next2} sessionId="session-1" />);

        const button = await screen.findByRole('button', { name: /jump to latest/i });
        expect(button).toBeTruthy();
        expect(button.getAttribute('aria-label')).toMatch(/jump to latest/i);
      } finally {
        restore();
      }
    });

    it('clicking jump-to-latest clears the unread badge and fires the smooth scrollTo call', async () => {
      const restore = stubContainerHeights();
      const scrollToSpy = Element.prototype.scrollTo as unknown as ReturnType<typeof vi.fn>;
      try {
        scrollToSpy.mockClear();
        const initial: Message[] = [
          createMockMessage({ id: 'u1', role: 'user', content: 'hi' }),
        ];
        const { container, rerender } = render(
          <MessageList messages={initial} sessionId="session-1" />
        );
        const scrollEl = getScrollContainer(container);
        await act(async () => {
          scrollEl.scrollTop = 50;
          scrollEl.dispatchEvent(new Event('scroll'));
        });

        const next: Message[] = [
          ...initial,
          createMockMessage({ id: 'u2', role: 'user', content: 'another' }),
        ];
        rerender(<MessageList messages={next} sessionId="session-1" />);

        const button = await screen.findByRole('button', { name: /jump to latest/i });
        await act(async () => {
          button.click();
        });

        // Plan 532: the click handler delegates to `container.scrollTo` so
        // the browser handles the smooth-scroll interpolation. Verify the
        // imperative scrollTo was called with the bottom-anchored target.
        expect(scrollToSpy).toHaveBeenCalled();
        const lastCall = scrollToSpy.mock.calls.at(-1)?.[0] as { top: number } | undefined;
        expect(lastCall?.top).toBe(scrollEl.scrollHeight);
      } finally {
        restore();
      }
    });
  });
});
