/**
 * project-actions.test.ts — Unit tests for the unified project + session
 * action helpers (Plan 547 Phase 2b).
 *
 * Strategy: mock the underlying IPC layer (`archiveThreadIPC`, `deleteThreadIPC`,
 * `updateThreadIPC`, `exportRolloutIPC`, `window.electronAPI.projects.*`) and
 * the `useConversationStore` / `useProjectsStore` Zustand stores, then verify
 * that each export routes to the right primitive in the right order, with the
 * right id set (project-scoped batch ops filter by `paths[]` matching).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks — must be hoisted before the module under test is imported.
// ---------------------------------------------------------------------------

const mocks = vi.hoisted(() => ({
  archiveIPC: vi.fn().mockResolvedValue(true),
  deleteIPC: vi.fn().mockResolvedValue(true),
  updateIPC: vi.fn().mockResolvedValue({} as never),
  exportIPC: vi.fn().mockResolvedValue({ absolutePath: '/tmp/x.jsonl', lines: 1, bytes: 1 }),
  projectsDelete: vi.fn().mockResolvedValue({ success: true, deleted: true }),
  projectsUpdate: vi.fn().mockResolvedValue({ success: true }),
  projectsInvalidate: vi.fn(),
  writeText: vi.fn().mockResolvedValue(undefined),
  openPath: vi.fn().mockResolvedValue(''),
  notifyThreadsChanged: vi.fn(),
}));

vi.mock('../ipc-client', () => ({
  archiveThreadIPC: mocks.archiveIPC,
  deleteThreadIPC: mocks.deleteIPC,
  updateThreadIPC: mocks.updateIPC,
  exportRolloutIPC: mocks.exportIPC,
}));

// Stub the clipboard global because jsdom does not provide a clipboard in tests.
Object.defineProperty(navigator, 'clipboard', {
  value: { writeText: mocks.writeText },
  configurable: true,
});

vi.stubGlobal('window', {
  electronAPI: {
    projects: {
      delete: mocks.projectsDelete,
      update: mocks.projectsUpdate,
    },
    shell: { openPath: mocks.openPath },
    sync: { notifyThreadsChanged: mocks.notifyThreadsChanged },
  },
});

// We import the module under test AFTER mocks are set up.
import * as actions from '../project-actions';
import { useConversationStore } from '@/stores/conversation-store';
import {
  useProjectsStore,
  type ProjectEntity,
} from '@/stores/projects-store';

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const PROJECT_A: ProjectEntity = {
  project_id: 'uuid-a',
  canonical_root: 'E:/Projects/duya',
  name: 'duya',
  description: 'main repo',
  paths: [
    { path: 'E:/Projects/duya', description: null },
    { path: 'E:/Projects/duya-website', description: 'website' },
  ],
  icon: null,
  color: null,
  created_at: 1_000,
  last_seen_at: 2_000,
};

function makeThread(id: string, workingDirectory: string): {
  id: string;
  title: string;
  workingDirectory: string;
  messages: never[];
  pinned?: boolean;
} {
  return {
    id,
    title: id,
    workingDirectory,
    messages: [],
    pinned: false,
  };
}

function resetStores(): void {
  useConversationStore.setState({
    threads: [],
    messages: {},
    activeThreadId: null,
  } as never);
  useProjectsStore.setState({
    projects: [PROJECT_A],
    hydrated: true,
    loading: false,
    error: null,
  });
}

beforeEach(() => {
  mocks.archiveIPC.mockClear();
  mocks.deleteIPC.mockClear();
  mocks.updateIPC.mockClear();
  mocks.exportIPC.mockClear();
  mocks.projectsDelete.mockClear();
  mocks.projectsUpdate.mockClear();
  mocks.projectsInvalidate.mockClear();
  mocks.writeText.mockClear();
  mocks.openPath.mockClear();
  mocks.notifyThreadsChanged.mockClear();
  resetStores();
});

afterEach(() => {
  vi.unstubAllGlobals();
  // Re-stub after unstubbing because the module reads it at call time.
  vi.stubGlobal('window', {
    electronAPI: {
      projects: {
        delete: mocks.projectsDelete,
        update: mocks.projectsUpdate,
      },
      shell: { openPath: mocks.openPath },
      sync: { notifyThreadsChanged: mocks.notifyThreadsChanged },
    },
  });
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('project-actions — single-session wrappers', () => {
  it('archiveSingleSession invokes the store archiveThread', () => {
    useConversationStore.setState({
      threads: [makeThread('t-1', 'E:/x')],
      messages: {},
      activeThreadId: null,
    } as never);
    // Spy on the store method via getState.
    const archiveSpy = vi.spyOn(useConversationStore.getState(), 'archiveThread');
    actions.archiveSingleSession('t-1');
    expect(archiveSpy).toHaveBeenCalledWith('t-1');
  });

  it('deleteSingleSession invokes the store deleteThread', () => {
    useConversationStore.setState({
      threads: [makeThread('t-1', 'E:/x')],
      messages: {},
      activeThreadId: null,
    } as never);
    const spy = vi.spyOn(useConversationStore.getState(), 'deleteThread');
    actions.deleteSingleSession('t-1');
    expect(spy).toHaveBeenCalledWith('t-1');
  });

  it('renameSingleSession calls updateThreadIPC with the new title', async () => {
    await actions.renameSingleSession('t-1', 'New Title');
    expect(mocks.updateIPC).toHaveBeenCalledWith('t-1', { title: 'New Title' });
  });

  it('exportSingleSessionRollout returns the IPC result', async () => {
    const out = await actions.exportSingleSessionRollout('t-1');
    expect(mocks.exportIPC).toHaveBeenCalledWith('t-1');
    expect(out).toEqual({ absolutePath: '/tmp/x.jsonl', lines: 1, bytes: 1 });
  });

  it('toggleSessionPin flips the pin flag', () => {
    const setPinned = vi.fn();
    useConversationStore.setState({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      setThreadPinned: setPinned as any,
      threads: [],
      messages: {},
      activeThreadId: null,
    } as never);
    actions.toggleSessionPin({ id: 't-1', pinned: false });
    expect(setPinned).toHaveBeenCalledWith('t-1', true);
  });

  it('copySessionId writes the id to the clipboard', async () => {
    await actions.copySessionId('t-1');
    expect(mocks.writeText).toHaveBeenCalledWith('t-1');
  });
});

describe('project-actions — selected-set batch ops', () => {
  it('archiveSelectedSessions calls archiveThread once per id (no filtering)', async () => {
    useConversationStore.setState({
      threads: [makeThread('t-1', 'E:/x'), makeThread('t-2', 'F:/y')],
      messages: {},
      activeThreadId: null,
    } as never);
    const spy = vi.spyOn(useConversationStore.getState(), 'archiveThread');
    const count = await actions.archiveSelectedSessions(['t-1', 't-2']);
    expect(spy).toHaveBeenCalledTimes(2);
    expect(spy).toHaveBeenNthCalledWith(1, 't-1');
    expect(spy).toHaveBeenNthCalledWith(2, 't-2');
    expect(count).toBe(2);
  });

  it('deleteSelectedSessions calls deleteThread once per id', async () => {
    useConversationStore.setState({
      threads: [makeThread('t-1', 'E:/x')],
      messages: {},
      activeThreadId: null,
    } as never);
    const spy = vi.spyOn(useConversationStore.getState(), 'deleteThread');
    const count = await actions.deleteSelectedSessions(['t-1']);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith('t-1');
    expect(count).toBe(1);
  });

  it('archiveSelectedSessions returns 0 for empty input', async () => {
    const spy = vi.spyOn(useConversationStore.getState(), 'archiveThread');
    const count = await actions.archiveSelectedSessions([]);
    expect(spy).not.toHaveBeenCalled();
    expect(count).toBe(0);
  });
});

describe('project-actions — project-scoped batch ops', () => {
  it('getSessionIdsUnderProject matches sessions by any of the project paths', () => {
    useConversationStore.setState({
      threads: [
        makeThread('t-1', 'E:/Projects/duya'),
        makeThread('t-2', 'E:/Projects/duya-website'),
        makeThread('t-3', 'F:/unrelated'),
      ],

      messages: {},
      activeThreadId: null,
    } as never);
    const ids = actions.getSessionIdsUnderProject(PROJECT_A);
    expect(ids.sort()).toEqual(['t-1', 't-2']);
  });

  it('getSessionIdsUnderProject uses the cross-platform normalizer', () => {
    useConversationStore.setState({
      // Session was authored on Windows as E:\Projects\duya\; project's paths[] are stored canonical as E:/Projects/duya. Both must match after normalization.
      threads: [makeThread('t-1', 'E:\\Projects\\duya\\')],
      messages: {},
      activeThreadId: null,
    } as never);
    const ids = actions.getSessionIdsUnderProject(PROJECT_A);
    expect(ids).toEqual(['t-1']);
  });

  it('archiveSessionsUnderProject calls archiveThread only for matching sessions', async () => {
    useConversationStore.setState({
      threads: [
        makeThread('t-1', 'E:/Projects/duya'),
        makeThread('t-2', 'F:/unrelated'),
      ],

      messages: {},
      activeThreadId: null,
    } as never);
    const spy = vi.spyOn(useConversationStore.getState(), 'archiveThread');
    const count = await actions.archiveSessionsUnderProject(PROJECT_A);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith('t-1');
    expect(count).toBe(1);
  });

  it('deleteSessionsUnderProject only touches matching sessions', async () => {
    useConversationStore.setState({
      threads: [
        makeThread('t-1', 'E:/Projects/duya'),
        makeThread('t-2', 'E:/Projects/duya-website'),
        makeThread('t-3', 'F:/unrelated'),
      ],

      messages: {},
      activeThreadId: null,
    } as never);
    const spy = vi.spyOn(useConversationStore.getState(), 'deleteThread');
    const count = await actions.deleteSessionsUnderProject(PROJECT_A);
    expect(spy).toHaveBeenCalledTimes(2);
    expect(count).toBe(2);
  });

  it('archiveSessionsUnderProject returns 0 when no sessions match', async () => {
    useConversationStore.setState({
      threads: [makeThread('t-1', 'F:/unrelated')],
      messages: {},
      activeThreadId: null,
    } as never);
    const spy = vi.spyOn(useConversationStore.getState(), 'archiveThread');
    const count = await actions.archiveSessionsUnderProject(PROJECT_A);
    expect(spy).not.toHaveBeenCalled();
    expect(count).toBe(0);
  });
});

describe('project-actions — entity-level ops', () => {
  it('deleteProject calls projects.delete once with the project id', async () => {
    const result = await actions.deleteProject(PROJECT_A);
    expect(mocks.projectsDelete).toHaveBeenCalledTimes(1);
    expect(mocks.projectsDelete).toHaveBeenCalledWith('uuid-a');
    expect(result).toBe(true);
  });

  it('deleteProject invalidates the projects store on success', async () => {
    const invalidateSpy = vi.spyOn(useProjectsStore.getState(), 'invalidate');
    await actions.deleteProject(PROJECT_A);
    expect(invalidateSpy).toHaveBeenCalledTimes(1);
  });

  it('deleteProject returns false when IPC reports failure', async () => {
    mocks.projectsDelete.mockResolvedValueOnce({ success: false, deleted: false });
    const invalidateSpy = vi.spyOn(useProjectsStore.getState(), 'invalidate');
    const result = await actions.deleteProject(PROJECT_A);
    expect(result).toBe(false);
    expect(invalidateSpy).not.toHaveBeenCalled();
  });

  it('renameProject calls projects.update with only the new name', async () => {
    await actions.renameProject(PROJECT_A, 'New Name');
    expect(mocks.projectsUpdate).toHaveBeenCalledTimes(1);
    expect(mocks.projectsUpdate).toHaveBeenCalledWith('uuid-a', { name: 'New Name' });
  });
});

describe('project-actions — convenience helpers', () => {
  it('openProjectFolder uses the first path', async () => {
    await actions.openProjectFolder(PROJECT_A);
    expect(mocks.openPath).toHaveBeenCalledWith('E:/Projects/duya');
  });

  it('openProjectFolder is a no-op when the project has no paths', async () => {
    await actions.openProjectFolder({ ...PROJECT_A, paths: [] });
    expect(mocks.openPath).not.toHaveBeenCalled();
  });

  it('copyProjectPath writes the first path to the clipboard', async () => {
    await actions.copyProjectPath(PROJECT_A);
    expect(mocks.writeText).toHaveBeenCalledWith('E:/Projects/duya');
  });

  it('deleteProjectAndSessions composes session delete + project delete', async () => {
    useConversationStore.setState({
      threads: [makeThread('t-1', 'E:/Projects/duya')],
      messages: {},
      activeThreadId: null,
    } as never);
    const deleteThreadSpy = vi.spyOn(useConversationStore.getState(), 'deleteThread');
    const result = await actions.deleteProjectAndSessions(PROJECT_A);
    expect(deleteThreadSpy).toHaveBeenCalledWith('t-1');
    expect(mocks.projectsDelete).toHaveBeenCalledWith('uuid-a');
    expect(result).toEqual({ sessionsDeleted: 1, projectDeleted: true });
  });
});
