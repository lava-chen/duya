// @vitest-environment jsdom
/**
 * BotContactListItem awaiting-input pill (Plan 516).
 *
 * The bot row's trailing slot now renders an amber pill when the bound
 * session is paused on a permission request (AskUserQuestion, generic
 * tool approval, or connector auth). Priority: awaiting-input > queued
 * > time, mirroring the same rules applied to ThreadListItem.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { BotContactListItem } from './BotContactListItem';
import type { BotContact } from './bot-contacts';

// Translation returns the key so assertions match i18n keys directly.
vi.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({
    t: (k: string, params?: Record<string, unknown>) =>
      params ? `${k} ${Object.values(params).join(' ')}` : k,
  }),
}));

const activityMocks = vi.hoisted(() => ({
  markSeen: vi.fn(),
  markErrored: vi.fn(),
  clearError: vi.fn(),
  lastSeenAt: {} as Record<string, number>,
  erroredAt: {} as Record<string, number>,
}));

vi.mock('@/stores/bot-activity-store', () => ({
  useBotActivityStore: (selector: (s: typeof activityMocks) => unknown) =>
    selector({
      lastSeenAt: activityMocks.lastSeenAt,
      erroredAt: activityMocks.erroredAt,
      markSeen: activityMocks.markSeen,
      markErrored: activityMocks.markErrored,
      clearError: activityMocks.clearError,
    }),
}));

vi.mock('@/stores/mailbox-store', () => ({
  // Component calls useMailboxStore((s) => s.bySession); honor the
  // selector and return a real Map so .get() works.
  useMailboxStore: (selector?: (s: { bySession: Map<string, unknown> }) => unknown) => {
    const state = { bySession: new Map() };
    return selector ? selector(state) : state;
  },
}));

vi.mock('@/components/chat/bot/use-bot-direct-transcript', () => ({
  useBotDirectTranscript: () => ({ messages: [] }),
}));

// Plan 516 — registry of stream listeners captured by mocked
// subscribeTo* exports; the pill tests push events into these arrays
// to drive the row's local state.
const streamMocks = vi.hoisted(() => ({
  phaseListeners: [] as Array<(phase: unknown) => void>,
  permissionListeners: [] as Array<(req: unknown) => void>,
  authListeners: [] as Array<(req: unknown) => void>,
}));

vi.mock('@/lib/stream-session-manager', () => ({
  subscribeToPhase: (_sessionId: string, cb: (phase: unknown) => void) => {
    streamMocks.phaseListeners.push(cb);
    return () => {
      const i = streamMocks.phaseListeners.indexOf(cb);
      if (i >= 0) streamMocks.phaseListeners.splice(i, 1);
    };
  },
  subscribeToPermissions: (_sessionId: string, cb: (req: unknown) => void) => {
    streamMocks.permissionListeners.push(cb);
    return () => {
      const i = streamMocks.permissionListeners.indexOf(cb);
      if (i >= 0) streamMocks.permissionListeners.splice(i, 1);
    };
  },
  subscribeToConnectorAuthRequired: (_sessionId: string, cb: (req: unknown) => void) => {
    streamMocks.authListeners.push(cb);
    return () => {
      const i = streamMocks.authListeners.indexOf(cb);
      if (i >= 0) streamMocks.authListeners.splice(i, 1);
    };
  },
}));

vi.mock('@/components/icons', () => ({
  ArchiveIcon: () => null,
  CaretRightIcon: () => null,
  CopyIcon: () => null,
  DotsThreeIcon: () => null,
  EyeSlashIcon: () => null,
  FolderIcon: () => null,
  NotePencilIcon: () => null,
  PinFilledIcon: () => null,
  PinIcon: () => null,
  PlusIcon: () => null,
  XIcon: () => null,
}));

function makeContact(overrides: Partial<BotContact> = {}): BotContact {
  return {
    agentId: 'agent-1',
    name: 'Test Bot',
    title: '',
    description: '',
    boundThreadId: 'bot:agent-1:session-1',
    lastActivity: Date.now() - 60000,
    ...overrides,
  } as BotContact;
}

describe('BotContactListItem awaiting-input pill (Plan 516)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    streamMocks.phaseListeners.length = 0;
    streamMocks.permissionListeners.length = 0;
    streamMocks.authListeners.length = 0;
  });

  it('renders no pill while the session is idle', () => {
    render(<BotContactListItem contact={makeContact()} isActive={false} onOpen={() => {}} />);
    expect(screen.queryByText('bot.contactStatus.awaitingAnswer')).toBeNull();
    expect(screen.queryByText('bot.contactStatus.awaitingPermission')).toBeNull();
    expect(screen.queryByText('bot.contactStatus.awaitingAuth')).toBeNull();
  });

  it('shows awaitingAnswer when an AskUserQuestion request arrives', () => {
    render(<BotContactListItem contact={makeContact()} isActive={false} onOpen={() => {}} />);
    expect(streamMocks.permissionListeners.length).toBe(1);
    act(() => {
      streamMocks.permissionListeners[0]({
        id: 'perm-1',
        toolName: 'AskUserQuestion',
      });
    });
    expect(screen.getByText('bot.contactStatus.awaitingAnswer')).toBeTruthy();
  });

  it('shows awaitingPermission for a non-AskUserQuestion tool', () => {
    render(<BotContactListItem contact={makeContact()} isActive={false} onOpen={() => {}} />);
    act(() => {
      streamMocks.permissionListeners[0]({
        id: 'perm-2',
        toolName: 'Bash',
      });
    });
    expect(screen.getByText('bot.contactStatus.awaitingPermission')).toBeTruthy();
  });

  it('clears the pill when the permission listener fires with null', () => {
    render(<BotContactListItem contact={makeContact()} isActive={false} onOpen={() => {}} />);
    act(() => {
      streamMocks.permissionListeners[0]({ id: 'perm-3', toolName: 'Bash' });
    });
    expect(screen.getByText('bot.contactStatus.awaitingPermission')).toBeTruthy();
    act(() => {
      streamMocks.permissionListeners[0](null);
    });
    expect(screen.queryByText('bot.contactStatus.awaitingPermission')).toBeNull();
  });

  it('shows awaitingAuth when a connector-auth request arrives', () => {
    render(<BotContactListItem contact={makeContact()} isActive={false} onOpen={() => {}} />);
    act(() => {
      streamMocks.authListeners[0]({ connectorId: 'github' });
    });
    expect(screen.getByText('bot.contactStatus.awaitingAuth')).toBeTruthy();
  });

  it('does not subscribe when the bot has no bound session', () => {
    render(
      <BotContactListItem
        contact={makeContact({ boundThreadId: null })}
        isActive={false}
        onOpen={() => {}}
      />,
    );
    expect(streamMocks.permissionListeners.length).toBe(0);
    expect(streamMocks.authListeners.length).toBe(0);
  });
});
