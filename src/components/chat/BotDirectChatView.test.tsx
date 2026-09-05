// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

// Translation returns the key so assertions match i18n keys directly.
vi.mock('@/hooks/useTranslation', () => ({
  // Params-aware: keys render as "key" (no params) or "key value1 ..." so
  // tests can assert interpolated values (plan 497 chip counts).
  useTranslation: () => ({
    t: (k: string, params?: Record<string, unknown>) =>
      params ? `${k} ${Object.values(params).join(' ')}` : k,
  }),
}));

// Plan 494: permission state is injected via a mocked usePermissions so
// the tests can drive the ask/permission cards without the SSE stack.
const permissionMocks = vi.hoisted(() => ({
  pendingPermission: null as import('@/types/stream').PermissionRequestEvent | null,
  respondToPermission: vi.fn(),
}));

vi.mock('@/hooks/usePermissions', () => ({
  usePermissions: () => ({
    pendingPermission: permissionMocks.pendingPermission,
    permissionResolved: null,
    respondToPermission: permissionMocks.respondToPermission,
    clearPermission: vi.fn(),
    handlePermissionRequest: vi.fn(),
  }),
}));

// stream-session-manager singleton is heavy and unneeded when the hook is
// mocked — the view only calls subscribeToPermissions for the live path.
vi.mock('@/lib/stream-session-manager', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/stream-session-manager')>();
  return {
    ...actual,
    subscribeToPermissions: () => () => {},
  };
});

// The view reads usePanel().openOrActivatePage for its header settings
// button; jsdom has no PanelProvider, so stub the whole hook module.
vi.mock('@/hooks/usePanel', () => ({
  usePanel: () => ({
    panelOpen: false,
    setPanelOpen: vi.fn(),
    togglePanel: vi.fn(),
    panelWidth: 0,
    setPanelWidth: vi.fn(),
    workspaceExpanded: false,
    setWorkspaceExpanded: vi.fn(),
    workspaceTreeOpen: false,
    setWorkspaceTreeOpen: vi.fn(),
    panelView: 'chat' as never,
    setPanelView: vi.fn(),
    tabs: [],
    activeTabId: null,
    openPanel: vi.fn(() => 'tab'),
    closePanel: vi.fn(),
    activateTab: vi.fn(),
    updateTabTitle: vi.fn(),
    updateTabFavicon: vi.fn(),
    rememberUserWidth: vi.fn(),
    resetPanelWidth: vi.fn(),
    openOrActivatePage: vi.fn(() => 'tab'),
    reorderTabs: vi.fn(),
  }),
  useOptionalPanel: () => null,
}));

// Icons barrel pulls in @tabler/icons-react (heap heavy in tests).
// Mock every icon the bot chat import chain touches.
vi.mock('@/components/icons', () => ({
  ArrowLeftIcon: () => null,
  PaperclipIcon: () => null,
  ArrowUpIcon: () => null,
  CopyIcon: () => null,
  ReplyIcon: () => null,
  CheckIcon: () => null,
  ThumbsUpIcon: () => null,
  DotsThreeIcon: () => null,
  ChatCircleIcon: () => null,
  ChevronDownIcon: () => null,
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
  InfoIcon: () => null,
  ShieldIcon: () => null,
  // panels/registry icons (pulled in via usePanel → registry.ts).
  FolderIcon: () => null,
  FileTextIcon: () => null,
  GitDiffIcon: () => null,
  GlobeIcon: () => null,
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

// Plan 497: the pair overlay's data hook needs the electronAPI fetch path,
// absent in jsdom — stub fixed entries so the overlay body is assertable.
vi.mock('./bot/use-agent-dm-pair', () => ({
  useAgentDmPairMessages: () => ({
    entries: [
      {
        key: 'pair-k1',
        senderAgentId: 'test1',
        text: '原始正文',
        timestamp: 1700000000000,
        intent: null,
        priority: false,
      },
    ],
    isLoading: false,
    refresh: () => {},
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
  permissionMocks.pendingPermission = null;
  window.localStorage.removeItem('duya:bot-chat:thumbs-up');
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
    // Rakazo parity: both roles get the hover overlay (time + pill).
    expect(rows[0].querySelector('.bot-message-hover-metadata')).not.toBeNull();
    expect(rows[2].querySelector('.bot-message-hover-metadata')).not.toBeNull();
    expect(rows[0].querySelector('.bot-message-hover-pill')).not.toBeNull();
    expect(screen.getByText('你好')).toBeDefined();
    expect(screen.getByText('在的')).toBeDefined();
  });

  it('persists a thumbs-up reaction and shows the badge below the bubble', () => {
    const messages: Message[] = [
      msg({ id: 'r1', role: 'assistant', content: '可反应' }),
    ];
    const { container } = render(
      <BotDirectChatView {...baseProps} messages={messages} />,
    );
    const btn = screen.getByLabelText('Add thumbs-up');
    fireEvent.click(btn);
    expect(btn.getAttribute('aria-pressed')).toBe('true');
    expect(container.querySelector('.bot-chat-thumbs-badge')).not.toBeNull();
    const stored = JSON.parse(
      window.localStorage.getItem('duya:bot-chat:thumbs-up') || '[]',
    ) as string[];
    expect(stored).toContain('r1');
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

  // ─── Plan 494 — permission cards in the transcript ───

  const askPermission = {
    id: 'perm-ask-1',
    toolName: 'AskUserQuestion',
    mode: 'ask_user_question',
    expiresAt: Date.now() + 60_000,
    toolInput: {
      questions: [
        {
          question: 'Which database?',
          header: 'Storage',
          multiSelect: false,
          options: [{ label: 'PostgreSQL' }, { label: 'SQLite (Recommended)' }],
        },
      ],
    },
  } as import('@/types/stream').PermissionRequestEvent;

  it('renders a pending AskUserQuestion as an in-chat ask card', () => {
    permissionMocks.pendingPermission = askPermission;
    const { container } = render(<BotDirectChatView {...baseProps} messages={[]} />);
    const row = container.querySelector('.bot-chat-row--assistant .bot-ask-card');
    expect(row).not.toBeNull();
    expect(screen.getByText('Which database?')).toBeDefined();
    expect(screen.getByText('PostgreSQL')).toBeDefined();
  });

  it('submits the ask card through respondToPermission and keeps an answered trace', async () => {
    permissionMocks.pendingPermission = askPermission;
    const { container } = render(<BotDirectChatView {...baseProps} messages={[]} />);
    // Recommended option auto-preselected → submit directly.
    fireEvent.click(screen.getByText('permission.continueHint'));
    expect(permissionMocks.respondToPermission).toHaveBeenCalledWith(
      'allow',
      expect.objectContaining({
        answers: { 'Which database?': 'SQLite (Recommended)' },
      }),
    );
    // Answered trace replaces the pending card (state updates in an effect
    // after submit, so wait for it).
    await waitFor(() => {
      expect(container.querySelector('.bot-ask-card--answered')).not.toBeNull();
    });
    expect(container.querySelector('.bot-ask-card:not(.bot-ask-card--answered)')).toBeNull();
  });

  it('renders a newer pending ask AFTER the earlier answered trace', async () => {
    permissionMocks.pendingPermission = askPermission;
    const { container, rerender } = render(<BotDirectChatView {...baseProps} messages={[]} />);
    fireEvent.click(screen.getByText('permission.continueHint'));
    await waitFor(() => {
      expect(container.querySelector('.bot-ask-card--answered')).not.toBeNull();
    });
    // A second question arrives — it must render BELOW the answered trace.
    permissionMocks.pendingPermission = { ...askPermission, id: 'perm-ask-2' };
    rerender(<BotDirectChatView {...baseProps} messages={[]} />);
    await waitFor(() => {
      const cards = container.querySelectorAll('.bot-ask-card');
      expect(cards.length).toBe(2);
      expect(cards[0].classList.contains('bot-ask-card--answered')).toBe(true);
      expect(cards[1].classList.contains('bot-ask-card--answered')).toBe(false);
    });
  });

  it('renders generic tool permissions as a compact approval card', () => {
    permissionMocks.pendingPermission = {
      id: 'perm-generic-1',
      toolName: 'Bash',
      mode: 'generic',
      expiresAt: Date.now() + 60_000,
      toolInput: { command: 'npm test' },
    } as import('@/types/stream').PermissionRequestEvent;
    const { container } = render(<BotDirectChatView {...baseProps} messages={[]} />);
    expect(container.querySelector('.bot-permission-card')).not.toBeNull();
    expect(screen.getByText('Bash')).toBeDefined();
    fireEvent.click(screen.getByText('permission.deny'));
    expect(permissionMocks.respondToPermission).toHaveBeenCalledWith('deny', undefined, undefined);
  });

  // Plan 497 — collapsed DM chips + read-only pair overlay.
  describe('agent DM chips (plan 497)', () => {
    function dm(partial: {
      id: string;
      direction: 'sent' | 'received';
      peerId: string;
      peerName?: string;
      text?: string;
    }): Message {
      const peerName = partial.peerName ?? partial.peerId;
      const text = partial.text ?? 'hello';
      return msg({
        id: partial.id,
        role: partial.direction === 'sent' ? 'assistant' : 'user',
        content: `→ ${peerName}: ${text}`,
        source: 'agent_dm',
        agentDmMeta: {
          direction: partial.direction,
          peerId: partial.peerId,
          peerName,
          text,
        },
      });
    }

    it('collapses consecutive same-peer markers into one clickable chip', () => {
      const messages: Message[] = [
        msg({ id: 'm1', role: 'user', content: '帮我问问' }),
        dm({ id: 'd1', direction: 'sent', peerId: 'peer-a', peerName: '原型师' }),
        dm({ id: 'd2', direction: 'sent', peerId: 'peer-a', peerName: '原型师' }),
      ];
      const { container } = render(<BotDirectChatView {...baseProps} messages={messages} />);
      const chips = container.querySelectorAll('.bot-chat-dm-chip');
      expect(chips.length).toBe(1);
      // Full marker bodies never render as bubbles in the transcript.
      expect(container.textContent).not.toContain('hello');
      expect(screen.getByText('bot.dm.chipSent', { exact: false })).toBeDefined();
      expect(container.textContent).toContain('bot.dm.chipCount 2');
    });

    it('splits separate bursts between the same pair into distinct chips', () => {
      const messages: Message[] = [
        dm({ id: 'd1', direction: 'sent', peerId: 'peer-a' }),
        msg({ id: 'm1', role: 'user', content: '中间插了一条' }),
        dm({ id: 'd2', direction: 'sent', peerId: 'peer-a' }),
      ];
      const { container } = render(<BotDirectChatView {...baseProps} messages={messages} />);
      expect(container.querySelectorAll('.bot-chat-dm-chip').length).toBe(2);
    });

    it('hands the peer to App navigation when a chip is clicked', () => {
      const messages: Message[] = [
        dm({ id: 'd1', direction: 'sent', peerId: 'peer-a', peerName: '原型师', text: '原始正文' }),
      ];
      const onOpenDmPair = vi.fn();
      const { container } = render(
        <BotDirectChatView {...baseProps} messages={messages} onOpenDmPair={onOpenDmPair} />,
      );
      fireEvent.click(container.querySelector('.bot-chat-dm-chip')!);
      expect(onOpenDmPair).toHaveBeenCalledWith('peer-a', '原型师');
    });

    it('drops hidden-source rows (wake prompts) behind the DM chip', () => {
      const messages: Message[] = [
        dm({ id: 'd1', direction: 'received', peerId: 'peer-a', peerName: '幕僚长', text: '同步状态' }),
        // Wake-run prompt row: persisted source 'system' (plan 497). The
        // App ingestion filter drops it before the store; the view mirrors
        // the same source rule as defense in depth.
        msg({
          id: 'wake-1',
          role: 'user',
          source: 'system',
          content: "[agent] A message just arrived from another of your user's agents.",
        }),
      ];
      const { container } = render(<BotDirectChatView {...baseProps} messages={messages} />);
      expect(container.querySelector('.bot-chat-dm-chip')).not.toBeNull();
      expect(container.textContent).not.toContain('[agent]');
    });

    it('collapses a fan-out burst into one chip with a peer roster popover', () => {
      const messages: Message[] = [
        dm({ id: 'd1', direction: 'sent', peerId: 'peer-a', peerName: '工程师' }),
        dm({ id: 'd2', direction: 'sent', peerId: 'peer-b', peerName: '研究员' }),
      ];
      const onOpenDmPair = vi.fn();
      const { container } = render(
        <BotDirectChatView {...baseProps} messages={messages} onOpenDmPair={onOpenDmPair} />,
      );
      const chips = container.querySelectorAll('.bot-chat-dm-chip');
      expect(chips.length).toBe(1);
      expect(chips[0].getAttribute('data-direction')).toBe('multi');
      // Popover opens on chip click; a roster row hands the peer to App.
      fireEvent.click(chips[0]);
      const rows = container.querySelectorAll('.bot-chat-dm-chip__popover-row');
      expect(rows.length).toBe(2);
      fireEvent.click(rows[1]);
      expect(onOpenDmPair).toHaveBeenCalledWith('peer-b', '研究员');
    });
  });
});
