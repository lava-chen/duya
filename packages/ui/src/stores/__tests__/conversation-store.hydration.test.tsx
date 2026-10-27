// @vitest-environment jsdom
/**
 * Persistence hydration must be PUBLISHED, not just applied.
 *
 * `zustand/persist` restores the saved state with a single write:
 * `set(merge(persistedState, currentState), true)`. Everything the merge
 * returns reaches every subscriber with that one write.
 *
 * The previous implementation did the normalisation in
 * `onRehydrateStorage`, whose callback runs AFTER that write and mutates
 * the state object in place. The field values changed, but no subscriber
 * was ever told — so `isHydrated` stayed `false` in the UI even though
 * persistence had finished. The boot splash then waited for its 5s
 * watchdog, the sidebar waited for `isHydrated` before loading the
 * session list, and the welcome-screen composer waited for `isHydrated`
 * before accepting input.
 *
 * The contract pinned here:
 *   - a store subscriber is notified with `isHydrated === true` when
 *     rehydration completes,
 *   - a React subscriber that selects `isHydrated` (the shape every
 *     consumer uses) re-renders with `true`,
 *   - the restored values (`collapsedProjects`, `expandedThreads`, the
 *     persisted draft, the sort/group model) are the normalised ones.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, act } from '@testing-library/react';
import { useShallow } from 'zustand/react/shallow';

const mocks = vi.hoisted(() => ({
  listThreadsIPC: vi.fn(async (): Promise<unknown[]> => []),
  listArchivedThreadsIPC: vi.fn(async (): Promise<unknown[]> => []),
  getProjectGroupsIPC: vi.fn(async (): Promise<unknown[]> => []),
  getNoProjectWorkspaceIPC: vi.fn(async () => '/tmp/duya-workspace'),
  getActiveProviderIPC: vi.fn(async (): Promise<unknown> => null),
  getAllSettingsIPC: vi.fn(async () => ({})),
  listProvidersIPC: vi.fn(async (): Promise<unknown[]> => []),
}));

vi.mock('@/lib/ipc-client', () => ({
  listThreadsIPC: mocks.listThreadsIPC,
  getThreadIPC: vi.fn(async () => null),
  createThreadIPC: vi.fn(async () => ({ id: 'db-row' })),
  deleteThreadIPC: vi.fn(async () => true),
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
  updateThreadIPC: vi.fn(),
  truncateMessagesAfterIPC: vi.fn(),
  truncateMessagesFromInclusiveIPC: vi.fn(),
}));

vi.mock('@/lib/agent-http-client', () => ({
  getAgentServerClient: vi.fn(() => ({})),
}));

import {
  useConversationStore,
  normalizeHydratedConversationState,
} from '../conversation-store';

const STORAGE_KEY = 'duya-conversations';

/** Seed localStorage with a persisted conversation state. */
function seedPersistedState(state: Record<string, unknown>) {
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ state, version: 0 }));
}

describe('conversation store — persistence hydration is published', () => {
  beforeEach(() => {
    window.localStorage.clear();
    vi.clearAllMocks();
    // Put the store back into its pre-hydration condition so the rehydrate
    // below is the thing under test.
    useConversationStore.setState({ isHydrated: false });
  });

  it('notifies store subscribers with isHydrated true when rehydration completes', async () => {
    seedPersistedState({ collapsedProjects: ['/work/demo'], expandedThreads: [] });

    const seen: boolean[] = [];
    const unsubscribe = useConversationStore.subscribe((state) => {
      seen.push(state.isHydrated);
    });

    await act(async () => {
      await useConversationStore.persist.rehydrate();
    });
    unsubscribe();

    // The write that publishes the restored state must carry the hydrated
    // flag. A subscriber that never sees `true` is the bug.
    expect(seen).toContain(true);
  });

  it('re-renders a React subscriber that selects isHydrated', async () => {
    seedPersistedState({ collapsedProjects: [], expandedThreads: [] });

    const renders: boolean[] = [];
    function Probe() {
      const { isHydrated } = useConversationStore(
        useShallow((state) => ({ isHydrated: state.isHydrated })),
      );
      renders.push(isHydrated);
      return null;
    }

    render(<Probe />);
    expect(renders.at(-1)).toBe(false);

    await act(async () => {
      await useConversationStore.persist.rehydrate();
    });

    expect(renders.at(-1)).toBe(true);
  });

  it('restores the collapsed / expanded project sets as Sets', async () => {
    seedPersistedState({ collapsedProjects: ['/work/demo'], expandedThreads: ['t-1'] });

    await act(async () => {
      await useConversationStore.persist.rehydrate();
    });

    const state = useConversationStore.getState();
    expect(state.collapsedProjects).toBeInstanceOf(Set);
    expect(state.collapsedProjects.has('/work/demo')).toBe(true);
    expect(state.expandedThreads).toBeInstanceOf(Set);
    expect(state.expandedThreads.has('t-1')).toBe(true);
  });

  it('publishes the restored sets to subscribers', async () => {
    seedPersistedState({ collapsedProjects: ['/work/demo'], expandedThreads: [] });

    const seen: unknown[] = [];
    const unsubscribe = useConversationStore.subscribe((state) => {
      seen.push(state.collapsedProjects);
    });

    await act(async () => {
      await useConversationStore.persist.rehydrate();
    });
    unsubscribe();

    const restored = seen.filter(
      (value): value is Set<string> => value instanceof Set && value.has('/work/demo'),
    );
    expect(restored.length).toBeGreaterThan(0);
  });
});

describe('normalizeHydratedConversationState', () => {
  const base = {
    isHydrated: false,
    collapsedProjects: [] as string[],
    expandedThreads: [] as string[],
    lastSyncAt: 0,
    newChatDraft: { text: '', attachments: [], hasContent: false },
    projectSortBy: 'lastActivity',
    projectGroupBy: 'byProject',
  };

  it('marks the state hydrated', () => {
    const next = normalizeHydratedConversationState({ ...base } as never);
    expect(next.isHydrated).toBe(true);
  });

  it('turns the persisted arrays back into Sets', () => {
    const next = normalizeHydratedConversationState({
      ...base,
      collapsedProjects: ['/a'],
      expandedThreads: ['/b'],
    } as never);
    expect(next.collapsedProjects).toBeInstanceOf(Set);
    expect([...(next.collapsedProjects as unknown as Set<string>)]).toEqual(['/a']);
    expect([...(next.expandedThreads as unknown as Set<string>)]).toEqual(['/b']);
  });

  it('derives hasContent for a persisted draft that lacks it', () => {
    const next = normalizeHydratedConversationState({
      ...base,
      newChatDraft: { text: '  hello  ', attachments: [] },
    } as never);
    expect(next.newChatDraft.hasContent).toBe(true);
    expect(next.newChatDraft.text).toBe('  hello  ');
  });

  it('repairs a persisted draft that is not an object', () => {
    const next = normalizeHydratedConversationState({
      ...base,
      newChatDraft: 'garbage',
    } as never);
    expect(next.newChatDraft).toEqual({ text: '', attachments: [], hasContent: false });
  });

  it('migrates the legacy sort and group values', () => {
    const next = normalizeHydratedConversationState({
      ...base,
      projectSortBy: 'createdAt',
      projectGroupBy: 'somethingElse',
    } as never);
    expect(next.projectSortBy).toBe('priority');
    // Claude parity (2026-10-26): the flat "all sessions" mode was removed,
    // so an unknown/legacy grouping lands on date groups.
    expect(next.projectGroupBy).toBe('byDate');
  });

  it('migrates the removed flat-list grouping to date groups', () => {
    const next = normalizeHydratedConversationState({
      ...base,
      projectGroupBy: 'singleList',
    } as never);
    expect(next.projectGroupBy).toBe('byDate');
  });
});
