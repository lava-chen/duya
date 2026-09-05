// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

// Translation returns the key so assertions match i18n keys directly.
vi.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}));

// Icons barrel pulls in @tabler/icons-react (heap heavy in tests).
// Mock every icon the bot chat import chain touches.
vi.mock('@/components/icons', () => ({
  ArrowLeftIcon: () => null,
  PaperclipIcon: () => null,
  ArrowUpIcon: () => null,
  CopyIcon: () => null,
  CheckIcon: () => null,
  DotsThreeIcon: () => null,
  ChatCircleIcon: () => null,
  BrainIcon: () => null,
  CaretRightIcon: () => null,
  WrenchIcon: () => null,
  XCircleIcon: () => null,
  CircleNotchIcon: () => null,
  // BotComposer chain (useSlashCommands / ModelProviderSelector /
  // SlashCommandPopover) imports these icons too.
  PlusIcon: () => null,
  XIcon: () => null,
  TerminalIcon: () => null,
  QuestionIcon: () => null,
  GlobeSimpleIcon: () => null,
  ClockCounterClockwiseIcon: () => null,
  ListChecksIcon: () => null,
  FeatherIcon: () => null,
  PlugIcon: () => null,
  ChalkboardIcon: () => null,
  ArrowsInLineVerticalIcon: () => null,
  TelescopeIcon: () => null,
  TargetArrowIcon: () => null,
  EyeIcon: () => null,
  MousePointerClickIcon: () => null,
  CaretDownIcon: () => null,
  SpinnerGapIcon: () => null,
  GearSixIcon: () => null,
  CubeIcon: () => null,
  CaretLeftIcon: () => null,
  RepeatIcon: () => null,
}));

// Composer fetches providers via the preload IPC bridge, which is absent in
// jsdom — stub just that call so the model picker stays empty instead of
// logging errors, while keeping the rest of ipc-client intact.
vi.mock('@/lib/ipc-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/ipc-client')>();
  return {
    ...actual,
    listProvidersIPC: () => Promise.resolve([]),
  };
});

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
  // Mirror the real hook's return shape (allContacts; pinned/unpinned/hidden).
  useBotContacts: () => ({
    allContacts: mocks.contacts,
    pinned: [],
    unpinned: [],
    hidden: [],
    loading: false,
    reload: mocks.reload,
  }),
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

  it('renders user and assistant bubbles without per-row avatar/name', () => {
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
    // Grok standard: rows carry no avatar/name — identity lives in the header.
    expect(container.querySelector('.bot-chat-row__avatar')).toBeNull();
    expect(container.querySelector('.bot-chat-row__name')).toBeNull();
    expect(rows[0].querySelector('.bot-chat-bubble--user')).not.toBeNull();
    expect(rows[2].querySelector('.bot-chat-bubble--assistant')).not.toBeNull();
    // Both roles get a hover-action anchor (copy).
    expect(rows[0].querySelector('.bot-message-action')).not.toBeNull();
    expect(rows[2].querySelector('.bot-message-action')).not.toBeNull();
    expect(screen.getByText('你好')).toBeDefined();
    expect(screen.getByText('在的')).toBeDefined();
  });

  it('inserts a date separator when the calendar day changes', () => {
    const day = 24 * 60 * 60 * 1000;
    const morning = new Date();
    morning.setHours(9, 0, 0, 0);
    const messages: Message[] = [
      msg({ id: 'd1', role: 'user', content: '昨天', timestamp: morning.getTime() - day }),
      msg({ id: 'd2', role: 'assistant', content: '嗯', timestamp: morning.getTime() - day + 1000 }),
      msg({ id: 'd3', role: 'user', content: '今天', timestamp: morning.getTime() }),
    ];
    const { container } = render(
      <BotDirectChatView {...baseProps} messages={messages} />,
    );
    const separators = container.querySelectorAll('.bot-chat-date-separator');
    expect(separators.length).toBe(2);
    // Separator text is a non-empty localized date.
    expect((separators[0].textContent || '').length).toBeGreaterThan(0);
  });

  it('keeps one separator for consecutive same-day messages', () => {
    const t0 = new Date();
    t0.setHours(9, 0, 0, 0);
    const messages: Message[] = [
      msg({ id: 's1', role: 'user', content: 'a', timestamp: t0.getTime() }),
      msg({ id: 's2', role: 'assistant', content: 'b', timestamp: t0.getTime() + 5000 }),
    ];
    const { container } = render(
      <BotDirectChatView {...baseProps} messages={messages} />,
    );
    expect(container.querySelectorAll('.bot-chat-date-separator').length).toBe(1);
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

  // Plan 489 P0.3 — wired (IPC present) path. The view is driven by
  // `useBotDirectTranscript`, which feeds the source-filtered projection
  // (send_message | user). Even when the unfiltered `messages` prop still
  // carries a tool_use row, the merge drops non-user local rows, so only
  // SendMessage/user content surfaces.
  it('shows only send_message rows once the source projection is wired', async () => {
    const fetchTranscript = vi.fn().mockResolvedValue([
      {
        id: 'sm1',
        role: 'assistant',
        content: 'SendMessage bubble',
        msg_type: 'text',
        source: 'send_message',
        created_at: 1,
      },
    ]);
    (window as unknown as { electronAPI: unknown }).electronAPI = {
      message: { botDirectGetTranscript: fetchTranscript },
      onMessageNew: () => () => {},
    };
    try {
      const messages: Message[] = [
        msg({ id: 'sm1', role: 'assistant', content: 'SendMessage bubble', msgType: 'text', source: 'send_message' }),
        // A tool_use row leaked in via the unfiltered store — must not render.
        msg({ id: 'tool1', role: 'assistant', content: '', msgType: 'tool_use', toolName: 'Read', source: 'tool_use' }),
      ];
      const { container } = render(
        <BotDirectChatView {...baseProps} messages={messages} />,
      );
      await waitFor(() => {
        expect(screen.getByText('SendMessage bubble')).toBeDefined();
      });
      // The SendMessage row renders as a bubble; the leaked tool row does not.
      expect(screen.queryByText('Read')).toBeNull();
      expect(container.querySelectorAll('.bot-chat-bubble').length).toBeGreaterThan(0);
    } finally {
      delete (window as unknown as { electronAPI?: unknown }).electronAPI;
    }
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
    // Unbound sessions get the placeholderUnbound label (exact aria-label).
    const input = screen.getByLabelText('bot.chat.placeholderUnbound') as HTMLTextAreaElement;
    expect(input.disabled).toBe(true);
    expect(input.placeholder).toBe('bot.chat.placeholderUnbound');
  });

  it('sends trimmed draft on click and clears the field', () => {
    render(<BotDirectChatView {...baseProps} messages={[]} />);
    const input = screen.getByLabelText('bot.chat.placeholder') as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: '  hello  ' } });
    fireEvent.click(screen.getByLabelText('bot.chat.send'));
    expect(baseProps.onSend).toHaveBeenCalledWith({ text: 'hello' });
    expect((screen.getByLabelText('bot.chat.placeholder') as HTMLTextAreaElement).value).toBe('');
  });

  it('sends on Enter without shift and inserts a newline with shift', () => {
    render(<BotDirectChatView {...baseProps} messages={[]} />);
    const input = screen.getByLabelText('bot.chat.placeholder') as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: 'hi' } });
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: false });
    expect(baseProps.onSend).toHaveBeenCalledWith({ text: 'hi' });
    expect(input.value).toBe('');
    fireEvent.change(input, { target: { value: 'line1' } });
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: true });
    expect(baseProps.onSend).toHaveBeenCalledTimes(1);
    expect(input.value).toBe('line1');
  });
});
