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
  // Plan 549 (Track B): unarchiveThread wires through the same store
  // selector pattern as archiveThread.
  unarchiveThread: vi.fn().mockResolvedValue(undefined),
  updateThreadTitle: vi.fn(),
  setThreadPinned: vi.fn(),
  // Plan 582 (G2): the row reads the whole roster to count the sub-agent
  // sessions an archive would take with it, so the archive confirm dialog can
  // say so. Without this key the selector returns undefined and every case in
  // this file dies on `threads.filter` before reaching its own assertion.
  threads: [] as Array<{ id: string; parentId: string | null }>,
}));

// Selector-aware mock. ThreadListItem now subscribes via per-action
// selectors (`useConversationStore((s) => s.deleteThread)`) so the
// mock must forward the selector to the store stub.
vi.mock('@/stores/conversation-store', () => ({
  useConversationStore: (selector?: (state: typeof storeMocks) => unknown) =>
    selector ? selector(storeMocks) : storeMocks,
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

function openMenu(title = 'My Thread'): void {
  // Claude parity (2026-10-22): the trigger's accessible name now names its
  // own row (`<title> options`), so two rows are distinguishable.
  fireEvent.click(
    screen.getByRole('button', { name: `thread.optionsFor ${title}` }),
  );
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

  it('archive item opens the G9 confirm step instead of archiving straight away', () => {
    // Plan 582 (G9): the menu item is confirm-then-act. `db:session:archive`
    // takes the session's whole spawn subtree, so a bare click is no longer
    // the size of action the label implies. This test previously asserted
    // the pre-G9 behaviour (one click archives) and has been red since.
    render(<ThreadListItem thread={makeThread()} isActive={false} />);
    openMenu();
    fireEvent.click(screen.getByText('thread.archiveThread'));

    expect(storeMocks.archiveThread).not.toHaveBeenCalled();
    expect(screen.getByTestId('archive-confirm')).toBeTruthy();

    // Confirming is what actually archives.
    fireEvent.click(screen.getByTestId('archive-confirm-ok'));
    expect(storeMocks.archiveThread).toHaveBeenCalledWith('s-1');
    expect(storeMocks.deleteThread).not.toHaveBeenCalled();
  });

  it('cancelling the G9 confirm step archives nothing', () => {
    render(<ThreadListItem thread={makeThread()} isActive={false} />);
    openMenu();
    fireEvent.click(screen.getByText('thread.archiveThread'));
    fireEvent.click(screen.getByText('common.cancel'));

    expect(storeMocks.archiveThread).not.toHaveBeenCalled();
    expect(screen.queryByTestId('archive-confirm')).toBeNull();
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

describe('ThreadListItem status mark (Codex parity)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    streamMocks.permissionListeners.length = 0;
    streamMocks.authListeners.length = 0;
    streamMocks.phaseListeners.length = 0;
  });

  it('renders NO status mark for an idle session', () => {
    // Codex parity (2026-10-22): the row has no leading glyph and idle
    // renders nothing at all — the resting state is not news. A hollow
    // ring on every row cost 12px each and made the list look busy.
    render(<ThreadListItem thread={makeThread()} isActive={false} />);
    expect(screen.queryByRole('img', { name: 'thread.status.idle' })).toBeNull();
    expect(document.querySelector('.thread-item-status')).toBeNull();
  });

  it('shows the running spinner in the trailing slot while a turn is in flight', () => {
    render(<ThreadListItem thread={makeThread()} isActive={false} />);
    act(() => {
      streamMocks.phaseListeners[0]('streaming');
    });
    const glyph = screen.getByRole('img', { name: 'thread.status.running' });
    expect(glyph.className).toContain('thread-item-status-running');
    expect(glyph.querySelector('.animate-spin')).toBeTruthy();
    // The mark lives in the trailing slot, after the title — not before it.
    const title = document.querySelector('.thread-item-title');
    expect(title).toBeTruthy();
    // DOCUMENT_POSITION_FOLLOWING means "glyph comes after title" in
    // document order.
    expect(
      title!.compareDocumentPosition(glyph) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it('keeps a failed turn visible as the error mark', () => {
    render(<ThreadListItem thread={makeThread()} isActive={false} />);
    act(() => {
      streamMocks.phaseListeners[0]('streaming');
    });
    act(() => {
      streamMocks.phaseListeners[0]('error');
    });
    expect(screen.getByRole('img', { name: 'thread.status.error' })).toBeTruthy();
  });

  it('lets "awaiting" win over "running" — a blocked turn is the actionable state', () => {
    // `awaiting_permission` is itself an active phase, so a naive
    // "running first" priority would hide the amber dot forever.
    render(<ThreadListItem thread={makeThread()} isActive={false} />);
    act(() => {
      streamMocks.phaseListeners[0]('awaiting_permission');
    });
    expect(screen.getByRole('img', { name: 'thread.status.running' })).toBeTruthy();
    act(() => {
      streamMocks.permissionListeners[0]({ id: 'perm-9', toolName: 'Bash' });
    });
    expect(
      screen.getByRole('img', { name: 'thread.status.awaitingInput' }),
    ).toBeTruthy();
  });
});

describe('ThreadListItem row menu set (Claude parity)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('orders the menu 固定 / 重命名 / 复制 / 归档 / 删除 with single-key hints', () => {
    render(<ThreadListItem thread={makeThread()} isActive={false} />);
    openMenu();

    const labels = Array.from(
      document.querySelectorAll('.sidebar-project-menu-item-label'),
    ).map((el) => el.textContent);
    expect(labels).toEqual([
      'thread.pinThread',
      'thread.renameThread',
      'thread.copyThreadId',
      'thread.exportRollout',
      'thread.archiveThread',
      'thread.deleteThread',
    ]);

    // The letters are shown only because the row implements them.
    for (const shortcut of ['P', 'R', 'A', 'D']) {
      expect(screen.getByText(shortcut)).toBeTruthy();
    }
  });

  it('shows "open folder" only when the session has a working directory', () => {
    const { unmount } = render(
      <ThreadListItem thread={makeThread()} isActive={false} />,
    );
    openMenu();
    expect(screen.queryByText('thread.openFolder')).toBeNull();
    unmount();

    render(
      <ThreadListItem
        thread={makeThread({ workingDirectory: 'E:/Projects/duya' })}
        isActive={false}
      />,
    );
    openMenu();
    expect(screen.getByText('thread.openFolder')).toBeTruthy();
  });

  it('row key commands drive the same handlers as the menu', () => {
    const { container } = render(
      <ThreadListItem thread={makeThread()} isActive={false} />,
    );
    const row = container.querySelector('.thread-item')!;

    fireEvent.keyDown(row, { key: 'p' });
    expect(storeMocks.setThreadPinned).toHaveBeenCalledWith('s-1', true);

    fireEvent.keyDown(row, { key: 'a' });
    expect(screen.getByTestId('archive-confirm')).toBeTruthy();

    fireEvent.keyDown(row, { key: 'Escape' });
    fireEvent.keyDown(row, { key: 'd' });
    expect(storeMocks.deleteThread).toHaveBeenCalledWith('s-1');
  });

  it('typing in the rename input never reaches the row commands', () => {
    // Regression: the row's keydown bubbles from the inline rename input, so
    // without an `e.target !== e.currentTarget` guard renaming to "docs"
    // would fire 删除 on the "d".
    render(<ThreadListItem thread={makeThread()} isActive={false} />);
    openMenu();
    fireEvent.click(screen.getByText('thread.renameThread'));

    const input = document.querySelector('.thread-item-rename-input') as HTMLInputElement;
    expect(input).toBeTruthy();
    for (const key of ['d', 'a', 'p']) {
      fireEvent.keyDown(input, { key });
    }
    expect(storeMocks.deleteThread).not.toHaveBeenCalled();
    expect(storeMocks.setThreadPinned).not.toHaveBeenCalled();
    expect(screen.queryByTestId('archive-confirm')).toBeNull();
  });
});

describe('ThreadListItem archive lifecycle (Plan 549)', () => {
  beforeEach(() => {
    storeMocks.archiveThread.mockClear();
    storeMocks.unarchiveThread.mockClear();
  });

  it('shows unarchive (not archive) when the thread is already archived', () => {
    const twoDaysAgo = Date.now() - 2 * 24 * 60 * 60 * 1000;
    render(
      <ThreadListItem
        thread={makeThread({ archivedAt: twoDaysAgo })}
        isActive={false}
      />,
    );
    openMenu();
    expect(screen.getByText('thread.unarchiveThread')).toBeTruthy();
    expect(screen.queryByText('thread.archiveThread')).toBeNull();
  });

  it('shows archive (not unarchive) for an active thread', () => {
    render(
      <ThreadListItem
        thread={makeThread({ archivedAt: null })}
        isActive={false}
      />,
    );
    openMenu();
    expect(screen.getByText('thread.archiveThread')).toBeTruthy();
    expect(screen.queryByText('thread.unarchiveThread')).toBeNull();
  });

  it('unarchive item invokes store.unarchiveThread with the thread id', async () => {
    render(
      <ThreadListItem
        thread={makeThread({ archivedAt: Date.now() - 1000 })}
        isActive={false}
      />,
    );
    openMenu();
    await act(async () => {
      fireEvent.click(screen.getByText('thread.unarchiveThread'));
    });
    expect(storeMocks.unarchiveThread).toHaveBeenCalledWith('s-1');
    expect(storeMocks.archiveThread).not.toHaveBeenCalled();
  });

  it('archived row carries the "archived" CSS class', () => {
    const { container } = render(
      <ThreadListItem
        thread={makeThread({ archivedAt: Date.now() - 1000 })}
        isActive={false}
      />,
    );
    const item = container.querySelector('.thread-item');
    expect(item).toBeTruthy();
    expect(item!.className).toContain('archived');
  });

  it('active row does NOT carry the "archived" CSS class', () => {
    const { container } = render(
      <ThreadListItem
        thread={makeThread({ archivedAt: null })}
        isActive={false}
      />,
    );
    const item = container.querySelector('.thread-item');
    expect(item).toBeTruthy();
    expect(item!.className).not.toContain('archived');
  });
});

