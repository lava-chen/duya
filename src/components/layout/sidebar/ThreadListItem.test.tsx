// @vitest-environment jsdom
/**
 * ThreadListItem menu (Plan 506 closeout).
 *
 * Pins the sidebar session menu wiring for the three rollout-first-class
 * actions: archive (C2), export rollout (A1), delete (unchanged behavior,
 * now with the trash icon). Handlers must call the store / IPC wrappers
 * with the thread id.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { act } from 'react';
import { ThreadListItem } from './ThreadListItem';
import type { Thread } from '@/stores/conversation-store';

// Translation returns the key so assertions match i18n keys directly.
vi.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({
    t: (k: string, params?: Record<string, unknown>) =>
      params ? `${k} ${Object.values(params).join(' ')}` : k,
  }),
}));

const storeMocks = vi.hoisted(() => ({
  setActiveThread: vi.fn(),
  deleteThread: vi.fn(),
  archiveThread: vi.fn(),
  updateThreadTitle: vi.fn(),
  setThreadPinned: vi.fn(),
}));

vi.mock('@/stores/conversation-store', () => ({
  useConversationStore: () => storeMocks,
}));

const ipcMocks = vi.hoisted(() => ({
  exportRollout: vi.fn(),
}));

vi.mock('@/lib/ipc-client', () => ({
  exportRolloutIPC: ipcMocks.exportRollout,
}));

const notifMocks = vi.hoisted(() => ({ show: vi.fn() }));

vi.mock('@/lib/notification', () => ({
  showNotification: notifMocks.show,
}));

// Plan 516 — registry of permission / auth listeners captured by the
// mocked subscribeTo* exports. The pill tests push events into these
// arrays via subscribeToPermissions(..., cb); the mock returns a fn that
// removes the entry, mirroring the real StreamSessionManager surface.
const streamMocks = vi.hoisted(() => ({
  permissionListeners: [] as Array<(req: unknown) => void>,
  authListeners: [] as Array<(req: unknown) => void>,
  phaseListeners: [] as Array<(phase: unknown) => void>,
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

function makeThread(overrides: Partial<Thread> = {}): Thread {
  return {
    id: 's-1',
    title: 'My Thread',
    workingDirectory: null,
    projectName: null,
    model: '',
    providerId: '',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    pinned: 0,
    ...overrides,
  } as Thread;
}

function openMenu(): void {
  fireEvent.click(screen.getByRole('button', { name: 'thread.options' }));
}

describe('ThreadListItem menu (Plan 506)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('menu stays closed until the dots button is clicked', () => {
    render(<ThreadListItem thread={makeThread()} isActive={false} />);
    expect(screen.queryByText('thread.archiveThread')).toBeNull();
    expect(screen.queryByText('thread.exportRollout')).toBeNull();
  });

  it('shows archive + export rollout items alongside delete', () => {
    render(<ThreadListItem thread={makeThread()} isActive={false} />);
    openMenu();
    expect(screen.getByText('thread.archiveThread')).toBeTruthy();
    expect(screen.getByText('thread.exportRollout')).toBeTruthy();
    expect(screen.getByText('thread.deleteThread')).toBeTruthy();
  });

  it('archive item calls store archiveThread with the thread id', () => {
    render(<ThreadListItem thread={makeThread()} isActive={false} />);
    openMenu();
    fireEvent.click(screen.getByText('thread.archiveThread'));
    expect(storeMocks.archiveThread).toHaveBeenCalledWith('s-1');
    expect(storeMocks.deleteThread).not.toHaveBeenCalled();
  });

  it('export item exports the rollout and notifies with the path', async () => {
    ipcMocks.exportRollout.mockResolvedValue({
      absolutePath: 'C:/exports/rollout-s-1.jsonl',
      lines: 12,
      bytes: 3400,
    });
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });

    render(<ThreadListItem thread={makeThread()} isActive={false} />);
    openMenu();
    fireEvent.click(screen.getByText('thread.exportRollout'));

    await waitFor(() => {
      expect(ipcMocks.exportRollout).toHaveBeenCalledWith('s-1');
    });
    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith('C:/exports/rollout-s-1.jsonl');
      expect(notifMocks.show).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'thread.exportDoneTitle',
          body: 'thread.exportDoneBody 12',
        }),
      );
    });
  });

  it('export failure is caught and does not notify', async () => {
    ipcMocks.exportRollout.mockRejectedValue(new Error('boom'));
    render(<ThreadListItem thread={makeThread()} isActive={false} />);
    openMenu();
    fireEvent.click(screen.getByText('thread.exportRollout'));

    await waitFor(() => {
      expect(ipcMocks.exportRollout).toHaveBeenCalledWith('s-1');
    });
    expect(notifMocks.show).not.toHaveBeenCalled();
  });
});
describe('ThreadListItem awaiting-input pill (Plan 516)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    streamMocks.permissionListeners.length = 0;
    streamMocks.authListeners.length = 0;
    streamMocks.phaseListeners.length = 0;
  });

  it('renders no pill while the session is idle', () => {
    render(<ThreadListItem thread={makeThread()} isActive={false} />);
    expect(screen.queryByText('bot.contactStatus.awaitingAnswer')).toBeNull();
    expect(screen.queryByText('bot.contactStatus.awaitingPermission')).toBeNull();
    expect(screen.queryByText('bot.contactStatus.awaitingAuth')).toBeNull();
  });

  it('shows awaitingAnswer when an AskUserQuestion request arrives', () => {
    render(<ThreadListItem thread={makeThread()} isActive={false} />);
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
    render(<ThreadListItem thread={makeThread()} isActive={false} />);
    act(() => {
      streamMocks.permissionListeners[0]({
        id: 'perm-2',
        toolName: 'Bash',
      });
    });
    expect(screen.getByText('bot.contactStatus.awaitingPermission')).toBeTruthy();
  });

  it('clears the pill when the permission listener fires with null', () => {
    render(<ThreadListItem thread={makeThread()} isActive={false} />);
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
    render(<ThreadListItem thread={makeThread()} isActive={false} />);
    act(() => {
      streamMocks.authListeners[0]({ connectorId: 'github' });
    });
    expect(screen.getByText('bot.contactStatus.awaitingAuth')).toBeTruthy();
  });
});

