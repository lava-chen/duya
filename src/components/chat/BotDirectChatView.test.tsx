// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

// Translation returns the key so assertions match i18n keys directly.
vi.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}));

// Icons barrel pulls in @tabler/icons-react (heap heavy in tests).
vi.mock('@/components/icons', () => ({
  ArrowLeftIcon: () => null,
}));

// Bot contacts hook: return a fixed contact with a bound session so the
// composer is enabled and the header shows identity fields.
const mocks = vi.hoisted(() => ({
  contacts: [
    {
      agentId: 'test1',
      name: '测试 Bot',
      title: '',
      description: '帮忙测试',
      model: 'glm-4',
      avatarShape: 'blob',
      avatarColor: 'blue',
      boundThreadId: 'bot:test1:abc',
      lastActivity: 0,
    },
  ],
  reload: vi.fn(),
}));

vi.mock('@/components/layout/sidebar/use-bot-contacts', () => ({
  useBotContacts: () => ({ contacts: mocks.contacts, loading: false, reload: mocks.reload }),
}));

import { BotDirectChatView } from './BotDirectChatView';
import type { Message } from '@/types/message';

function msg(partial: Partial<Message> & Pick<Message, 'id' | 'role' | 'content'>): Message {
  return { timestamp: 1, ...partial } as Message;
}

const baseProps = {
  sessionId: 'bot:test1:abc',
  isStreaming: false,
  isFinalizing: false,
  onSend: vi.fn(),
  onStop: vi.fn(),
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('BotDirectChatView', () => {
  it('renders the bot identity header with name and description', () => {
    render(<BotDirectChatView {...baseProps} messages={[]} />);
    // Header and empty state both surface the name — at least one each.
    expect(screen.getAllByText('测试 Bot').length).toBeGreaterThan(0);
    expect(screen.getAllByText('帮忙测试').length).toBeGreaterThan(0);
    expect(screen.getByLabelText('bot.chat.placeholder')).toBeDefined();
  });

  it('falls back to the agent id when no contact matches the session', () => {
    render(
      <BotDirectChatView {...baseProps} sessionId="bot:ghost" messages={[]} />,
    );
    expect(screen.getAllByText('ghost').length).toBeGreaterThan(0);
  });

  it('renders user and assistant text bubbles with group starts', () => {
    const messages: Message[] = [
      msg({ id: 'm1', role: 'user', content: '你好' }),
      msg({ id: 'm2', role: 'user', content: '还在吗' }),
      msg({ id: 'm3', role: 'assistant', content: '在的' }),
    ];
    const { container } = render(
      <BotDirectChatView {...baseProps} messages={messages} />,
    );
    const rows = container.querySelectorAll('.bot-chat-row');
    expect(rows.length).toBe(3);
    expect(rows[0].getAttribute('data-group-start')).toBe('true');
    // Consecutive user message is NOT a group start.
    expect(rows[1].getAttribute('data-group-start')).toBeNull();
    expect(rows[2].getAttribute('data-group-start')).toBe('true');
    // Group-start assistant row carries avatar + name gutter.
    expect(rows[2].querySelector('.bot-chat-row__name')?.textContent).toBe('测试 Bot');
    expect(screen.getByText('你好')).toBeDefined();
    expect(screen.getByText('在的')).toBeDefined();
  });

  it('renders tool_use messages as status chips, not bubbles', () => {
    const messages: Message[] = [
      msg({ id: 'm1', role: 'assistant', content: '', msgType: 'tool_use', toolName: 'Read' }),
    ];
    const { container } = render(
      <BotDirectChatView {...baseProps} messages={messages} />,
    );
    expect(container.querySelectorAll('.bot-chat-bubble').length).toBe(0);
    expect(screen.getByText('Read')).toBeDefined();
  });

  it('shows the typing indicator while streaming and swap send for stop', () => {
    const { container } = render(
      <BotDirectChatView {...baseProps} isStreaming messages={[]} />,
    );
    expect(container.querySelector('.bot-chat-typing')).not.toBeNull();
    expect(screen.getByLabelText('bot.chat.stop')).toBeDefined();
  });

  it('disables the composer for unbound placeholder sessions', () => {
    // bot:ghost matches no contact → no bound session → disabled.
    render(
      <BotDirectChatView
        {...baseProps}
        sessionId="bot:ghost"
        messages={[]}
      />,
    );
    const input = screen.getByLabelText('bot.chat.placeholder') as HTMLTextAreaElement;
    expect(input.disabled).toBe(true);
    expect(input.placeholder).toBe('bot.chat.placeholderUnbound');
  });

  it('sends trimmed draft on click and clears the field', () => {
    render(<BotDirectChatView {...baseProps} messages={[]} />);
    const input = screen.getByLabelText('bot.chat.placeholder') as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: '  hello  ' } });
    fireEvent.click(screen.getByLabelText('bot.chat.send'));
    expect(baseProps.onSend).toHaveBeenCalledWith('hello');
    expect((screen.getByLabelText('bot.chat.placeholder') as HTMLTextAreaElement).value).toBe('');
  });

  it('sends on Enter without shift and inserts a newline with shift', () => {
    render(<BotDirectChatView {...baseProps} messages={[]} />);
    const input = screen.getByLabelText('bot.chat.placeholder') as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: 'hi' } });
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: false });
    expect(baseProps.onSend).toHaveBeenCalledWith('hi');
    expect(input.value).toBe('');
    fireEvent.change(input, { target: { value: 'line1' } });
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: true });
    expect(baseProps.onSend).toHaveBeenCalledTimes(1);
    expect(input.value).toBe('line1');
  });
});
