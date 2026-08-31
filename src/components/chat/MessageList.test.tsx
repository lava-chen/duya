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
import { render, screen } from '@testing-library/react';
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
  global.ResizeObserver = vi.fn().mockImplementation(() => ({
    observe: vi.fn(),
    disconnect: vi.fn(),
  }));
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
});
