/**
 * Plan 582 (G5, G7) — the archived roster is a SECOND array, and several
 * per-thread actions used to touch only `threads`.
 *
 * G7: rename / pin / delete on a row rendered in the archived sidebar section
 *      updated local state that the archived row reads from a different place,
 *      so the UI looked like it had swallowed the click.
 * G5: clicking an archived row routed through `setActiveThread`, whose DB
 *      fallback injected the row into `threads`. Because `db:session:list`
 *      never returns archived rows (`status NOT IN ('deleted','archived')`),
 *      the pending-merge in `loadFromDatabase` re-accepted that row on every
 *      refetch — the archived session sat in the ACTIVE sidebar until an app
 *      restart.
 *
 * @vitest-environment jsdom
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  // getThreadIPC is the DB fallback setActiveThread reaches for a row that is
  // not in `threads`. Returning an ARCHIVED row here reproduces the G5 bug.
  getThreadIPC: vi.fn(async (): Promise<{ thread: Record<string, unknown> } | null> => null),
  updateThreadIPC: vi.fn(async () => ({})),
  deleteThreadIPC: vi.fn(async () => true),
  listThreadsIPC: vi.fn(async (): Promise<unknown[]> => []),
  listArchivedThreadsIPC: vi.fn(async (): Promise<unknown[]> => []),
  getProjectGroupsIPC: vi.fn(async () => []),
  getNoProjectWorkspaceIPC: vi.fn(async () => '/tmp/duya-workspace'),
  getActiveProviderIPC: vi.fn(async (): Promise<Record<string, unknown> | null> => null),
  getAllSettingsIPC: vi.fn(async () => ({})),
  listProvidersIPC: vi.fn(async () => []),
}));

vi.mock('@/lib/ipc-client', () => ({
  listThreadsIPC: mocks.listThreadsIPC,
  getThreadIPC: mocks.getThreadIPC,
  createThreadIPC: vi.fn(async () => ({ id: 'db-row' })),
  deleteThreadIPC: mocks.deleteThreadIPC,
  archiveThreadIPC: vi.fn(),
  unarchiveThreadIPC: vi.fn(),
  listArchivedThreadsIPC: mocks.listArchivedThreadsIPC,
  getProjectGroupsIPC: mocks.getProjectGroupsIPC,
  getNoProjectWorkspaceIPC: mocks.getNoProjectWorkspaceIPC,
  addRecentFolderIPC: vi.fn(),
  addMessageIPC: vi.fn(),
  getThreadMessagesIPC: vi.fn(async () => []),
  getActiveProviderIPC: mocks.getActiveProviderIPC,
  getAllSettingsIPC: mocks.getAllSettingsIPC,
  listProvidersIPC: mocks.listProvidersIPC,
  updateThreadIPC: mocks.updateThreadIPC,
  truncateMessagesAfterIPC: vi.fn(),
  truncateMessagesFromInclusiveIPC: vi.fn(),
}));

vi.mock('@/lib/agent-http-client', () => ({
  getAgentServerClient: vi.fn(() => ({})),
}));

import { useConversationStore, type Thread } from '../conversation-store';

const ARCHIVED_AT = Date.UTC(2026, 8, 7, 9, 30, 0);

function archivedThread(id: string, overrides: Partial<Thread> = {}): Thread {
  return {
    id,
    title: `archived ${id}`,
    updatedAt: ARCHIVED_AT,
    archivedAt: ARCHIVED_AT,
    archivedPath: `archived/2026-09-07/rollout-${id}.jsonl`,
    ...overrides,
  } as Thread;
}

function activeThread(id: string, overrides: Partial<Thread> = {}): Thread {
  return { id, title: `active ${id}`, updatedAt: 1000, ...overrides } as Thread;
}

function seed(threads: Thread[], archived: Thread[] = []) {
  useConversationStore.setState({
    threads,
    archivedThreads: archived,
    activeThreadId: null,
    // `loadFromDatabase` short-circuits for 30s once hydrated, which would
    // hide the pending-merge behaviour under test.
    isHydrated: false,
    lastSyncAt: 0,
  });
}

describe('Plan 582 G7 — actions must patch the archived roster too', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getThreadIPC.mockResolvedValue(null);
    seed([], [archivedThread('arch-1')]);
  });

  it('updateThreadTitle renames a row that only exists in archivedThreads', () => {
    useConversationStore.getState().updateThreadTitle('arch-1', 'renamed in archive');

    const row = useConversationStore.getState().archivedThreads.find((t) => t.id === 'arch-1');
    expect(row?.title).toBe('renamed in archive');
  });

  it('updateThreadTitle still reaches the DB for an archived row', () => {
    useConversationStore.getState().updateThreadTitle('arch-1', 'renamed in archive');
    // The old lookup read `threads` only, so an archived row was renamed
    // locally but never persisted — the title reverted on the next refetch.
    expect(mocks.updateThreadIPC).toHaveBeenCalledWith('arch-1', { title: 'renamed in archive' });
  });

  it('setThreadPinned reflects the pin on the archived row', () => {
    useConversationStore.getState().setThreadPinned('arch-1', true);

    const row = useConversationStore.getState().archivedThreads.find((t) => t.id === 'arch-1');
    expect(row?.pinned).toBe(1);
  });

  it('deleteThread removes the row from the archived roster immediately', async () => {
    // Regression: the row used to stay on screen until some later
    // archive/unarchive happened to refetch the roster.
    useConversationStore.getState().deleteThread('arch-1');

    expect(useConversationStore.getState().archivedThreads).toEqual([]);
    // Let the fire-and-forget IPC promise settle.
    await Promise.resolve();
    expect(mocks.listArchivedThreadsIPC).toHaveBeenCalled();
  });
});

describe('Plan 582 G5 — an archived row must never land in the active list', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    seed([], [archivedThread('arch-2')]);
  });

  it('setActiveThread does not promote an archived row into threads', async () => {
    // Reached via ThreadListItem's click handler, which has no archived
    // branch of its own.
    await useConversationStore.getState().setActiveThread('arch-2');

    expect(useConversationStore.getState().threads).toEqual([]);
    expect(useConversationStore.getState().archivedThreads.map((t) => t.id)).toEqual(['arch-2']);
  });

  it('routes a DB-fetched archived row to the archived roster, not threads', async () => {
    // The row is not cached anywhere yet, so setActiveThread falls through to
    // getThreadIPC. Pre-fix, that result was always spliced into `threads`.
    seed([], []);
    mocks.getThreadIPC.mockResolvedValue({
      thread: archivedThread('arch-3') as unknown as Record<string, unknown>,
    });

    await useConversationStore.getState().setActiveThread('arch-3');

    expect(useConversationStore.getState().threads).toEqual([]);
    expect(useConversationStore.getState().archivedThreads.map((t) => t.id)).toEqual(['arch-3']);
  });

  it('still promotes a normal active row fetched from the DB', async () => {
    // Guard against over-correcting: the active path must keep working.
    seed([], []);
    mocks.getThreadIPC.mockResolvedValue({
      thread: activeThread('live-1') as unknown as Record<string, unknown>,
    });

    await useConversationStore.getState().setActiveThread('live-1');

    expect(useConversationStore.getState().threads.map((t) => t.id)).toEqual(['live-1']);
  });

  it('loadFromDatabase drops a leaked archived row from the active list', async () => {
    // Self-healing backstop: even if some other path leaks an archived row
    // into `threads`, the pending-merge must not re-accept it. `db:session:list`
    // excludes archived rows, so `dbThreadIds` can never contain it.
    seed([archivedThread('leaked')], []);
    mocks.listThreadsIPC.mockResolvedValue([activeThread('live-2')]);

    await useConversationStore.getState().loadFromDatabase();

    const ids = useConversationStore.getState().threads.map((t) => t.id);
    expect(ids).toContain('live-2');
    expect(ids).not.toContain('leaked');
  });
});
