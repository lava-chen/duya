// @vitest-environment jsdom
/**
 * AgentDmPairView tests (plan 497) — full-container read-only pair view.
 * The data hook is mocked (fetch path needs electronAPI); assertions cover
 * the header identity, sender-side alignment mapping, and back navigation.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

vi.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({ t: (k: string, params?: Record<string, unknown>) =>
    params ? `${k} ${Object.values(params).join(' ')}` : k }),
}));

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

vi.mock('@/components/layout/sidebar/use-bot-contacts', () => ({
  useBotContacts: () => ({
    allContacts: [
      { agentId: 'bot-self', name: '幕僚长', avatarColor: 'blue' },
      { agentId: 'bot-peer', name: '原型师', avatarColor: 'orange' },
    ],
    pinned: [],
    unpinned: [],
    hidden: [],
    loading: false,
    reload: vi.fn(),
  }),
}));

const pairMocks = vi.hoisted(() => ({
  entries: [
    { key: 'k1', senderAgentId: 'bot-self', text: '同步一下分工', timestamp: 1700000000000, intent: null, priority: false },
    { key: 'k2', senderAgentId: 'bot-peer', text: '收到,我是原型师', timestamp: 1700000600000, intent: null, priority: false },
  ],
  isLoading: false,
}));

vi.mock('./use-agent-dm-pair', () => ({
  useAgentDmPairMessages: () => ({
    entries: pairMocks.entries,
    isLoading: pairMocks.isLoading,
    refresh: vi.fn(),
  }),
}));

import { AgentDmPairView } from './AgentDmPairView';

describe('AgentDmPairView', () => {
  beforeEach(() => {
    pairMocks.entries = [
      { key: 'k1', senderAgentId: 'bot-self', text: '同步一下分工', timestamp: 1700000000000, intent: null, priority: false },
      { key: 'k2', senderAgentId: 'bot-peer', text: '收到,我是原型师', timestamp: 1700000600000, intent: null, priority: false },
    ];
    pairMocks.isLoading = false;
  });

  it('renders the overlapping header identity and both message bodies', () => {
    const { container } = render(
      <AgentDmPairView
        selfAgentId="bot-self"
        sessionId="bot:bot-self"
        selfName="幕僚长"
        peerId="bot-peer"
        peerName="原型师"
        onBack={vi.fn()}
      />,
    );
    expect(container.querySelector('.bot-dm-pair-view__stack')).not.toBeNull();
    expect(container.textContent).toContain('幕僚长 · 原型师');
    // Raw DM bodies render via the reused BotBubbleRow.
    expect(container.textContent).toContain('同步一下分工');
    expect(container.textContent).toContain('收到,我是原型师');
    // Left-aligned author rows for BOTH bots, each with a name label; the
    // identity (avatar/name) marks who sent it, alignment is always left.
    expect(container.querySelectorAll('.bot-dm-pair-row').length).toBe(2);
    expect(container.querySelectorAll('.bot-dm-pair-row__name').length).toBe(2);
    expect(container.textContent).toContain('幕僚长');
    expect(container.textContent).toContain('原型师');
    // Both messages render as plain assistant bubbles (no user / contrast row).
    expect(container.querySelector('.bot-chat-row--user')).toBeNull();
    expect(container.querySelectorAll('.bot-chat-row--assistant').length).toBe(2);
    // Read-only footer with count.
    expect(container.textContent).toContain('bot.dm.pairReadonly');
    expect(container.textContent).toContain('bot.dm.pairCount 2');
  });

  it('returns to the bot chat via back arrow and footer button', () => {
    const onBack = vi.fn();
    const { container } = render(
      <AgentDmPairView
        selfAgentId="bot-self"
        sessionId="bot:bot-self"
        selfName="幕僚长"
        peerId="bot-peer"
        peerName="原型师"
        onBack={onBack}
      />,
    );
    fireEvent.click(container.querySelector('.bot-dm-pair-view__back')!);
    fireEvent.click(container.querySelector('.bot-dm-pair-view__back-btn')!);
    expect(onBack).toHaveBeenCalledTimes(2);
  });

  it('shows an empty-state note when the pair has no messages', () => {
    pairMocks.entries = [];
    const { container } = render(
      <AgentDmPairView
        selfAgentId="bot-self"
        sessionId="bot:bot-self"
        selfName="幕僚长"
        peerId="bot-peer"
        peerName="原型师"
        onBack={vi.fn()}
      />,
    );
    expect(container.textContent).toContain('bot.dm.pairEmpty');
  });
});
