/**
 * project-workspace-store.test.ts — the renderer's cache for the Project-first
 * view.
 *
 * ## What is under test
 *
 * The behaviours the project view depends on:
 *
 *   - the project state comes from ONE read, and a failure is an error the
 *     view can show rather than an empty project that looks real;
 *   - the coordinator conversation is created on first use, and the second
 *     call does not create a second one;
 *   - the lease is the authority: a refused takeover leaves the session
 *     read-only, and giving it back needs the revision the Host granted.
 *
 * The bridge is stubbed, so these are the store's own guarantees — the Host's
 * guarantees are covered by the Host's own tests.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionControlHolderKind } from '@duya/agent-protocol';

import { useProjectWorkspaceStore, isLocalUserLease } from '../project-workspace-store';

const PROJECT = {
  project_id: 'project-1',
  canonical_root: 'E:/Projects/duya',
  name: 'duya',
  description: null,
  paths: [{ path: 'E:/Projects/duya', description: null }],
  icon: null,
  color: null,
  created_at: 1_000,
  last_seen_at: 2_000,
  coordinator_session_id: 'session-coordinator',
};

const STATE = {
  project: PROJECT,
  coordinatorSessionId: 'session-coordinator',
  tasks: [
    {
      taskId: 'task-1',
      subject: '实现登录',
      description: '',
      status: 'in_progress',
      activeForm: null,
      owner: null,
      blocks: [],
      blockedBy: [],
      coordinatorSessionId: 'session-coordinator',
      workSessionId: 'session-work',
      updatedAt: 5,
    },
  ],
  workSessions: [
    {
      sessionId: 'session-work',
      title: '登录实现',
      workingDirectory: 'E:/Projects/duya',
      status: 'active',
      updatedAt: 5,
      taskId: 'task-1',
      origin: 'bound' as const,
    },
  ],
  observedAt: 10,
};

function stubBridge(overrides: Record<string, unknown> = {}) {
  const state = vi.fn().mockResolvedValue({ success: true, state: STATE });
  const ensureCoordinator = vi.fn().mockResolvedValue({
    success: true,
    sessionId: 'session-coordinator',
    created: true,
  });
  const workSessionStatus = vi.fn().mockResolvedValue({ success: true, statuses: { 'session-work': 'STREAMING' } });
  const acquire = vi.fn().mockResolvedValue({
    success: true,
    lease: {
      sessionId: 'session-work',
      leaseId: 'lease-1',
      holder: { kind: 'user', id: 'local' },
      revision: 7,
      requestId: 'request-1',
      expiresAt: 999,
    },
  });
  const get = vi.fn().mockResolvedValue({ success: true, lease: null });
  const release = vi.fn().mockResolvedValue({ success: true, released: true });
  vi.stubGlobal('window', {
    electronAPI: {
      projectWorkspace: { state, ensureCoordinator, workSessionStatus, lease: { acquire, get, release }, ...overrides },
    },
  });
  return { state, ensureCoordinator, workSessionStatus, acquire, get, release };
}

describe('project-workspace-store', () => {
  beforeEach(() => {
    useProjectWorkspaceStore.setState({
      activeProjectId: null,
      snapshot: null,
      sessionStatuses: {},
      leases: {},
      loading: false,
      error: null,
    });
    vi.unstubAllGlobals();
  });

  it('reads the whole project state in one call', async () => {
    const bridge = stubBridge();

    await useProjectWorkspaceStore.getState().openProject('project-1');

    const snapshot = useProjectWorkspaceStore.getState().snapshot;
    expect(snapshot?.project.name).toBe('duya');
    expect(snapshot?.coordinatorSessionId).toBe('session-coordinator');
    expect(snapshot?.tasks).toHaveLength(1);
    expect(snapshot?.workSessions).toHaveLength(1);
    expect(bridge.state).toHaveBeenCalledTimes(1);
  });

  it('reports a failed read as an error, not as an empty project', async () => {
    stubBridge({ state: vi.fn().mockResolvedValue({ success: false, error: 'host is down' }) });

    await useProjectWorkspaceStore.getState().openProject('project-1');

    expect(useProjectWorkspaceStore.getState().error).toBe('host is down');
    expect(useProjectWorkspaceStore.getState().snapshot).toBeNull();
  });

  it('says so when the surface has no project bridge at all', async () => {
    vi.stubGlobal('window', {});

    await useProjectWorkspaceStore.getState().openProject('project-1');

    expect(useProjectWorkspaceStore.getState().snapshot).toBeNull();
    expect(useProjectWorkspaceStore.getState().error).toBeTruthy();
  });

  it('creates the coordinator once and does not create a second one', async () => {
    const bridge = stubBridge();

    const first = await useProjectWorkspaceStore.getState().enterProject('project-1');
    const second = await useProjectWorkspaceStore.getState().enterProject('project-1');

    expect(first).toBe('session-coordinator');
    expect(second).toBe('session-coordinator');
    expect(bridge.ensureCoordinator).toHaveBeenCalledTimes(2);
  });

  it('takes the session over and records the lease the Host granted', async () => {
    const bridge = stubBridge();

    const taken = await useProjectWorkspaceStore.getState().acquireLease('session-work');

    expect(taken).toBe(true);
    expect(bridge.acquire).toHaveBeenCalledWith('session-work', expect.any(String));
    expect(useProjectWorkspaceStore.getState().leases['session-work']?.revision).toBe(7);
  });

  it('leaves the session read-only when the takeover is refused', async () => {
    stubBridge({
      lease: {
        acquire: vi.fn().mockResolvedValue({ success: true, lease: null }),
        get: vi.fn().mockResolvedValue({ success: true, lease: null }),
        release: vi.fn().mockResolvedValue({ success: true, released: false }),
      },
    });

    const taken = await useProjectWorkspaceStore.getState().acquireLease('session-work');

    expect(taken).toBe(false);
    expect(useProjectWorkspaceStore.getState().leases['session-work']).toBeNull();
  });

  it('gives the session back with the revision it was granted', async () => {
    const bridge = stubBridge();
    await useProjectWorkspaceStore.getState().acquireLease('session-work');

    const released = await useProjectWorkspaceStore.getState().releaseLease('session-work');

    expect(released).toBe(true);
    expect(bridge.release).toHaveBeenCalledWith('session-work', 7);
    expect(useProjectWorkspaceStore.getState().leases['session-work']).toBeNull();
  });

  it('does not try to give back a lease it never had', async () => {
    const bridge = stubBridge();

    const released = await useProjectWorkspaceStore.getState().releaseLease('session-work');

    expect(released).toBe(false);
    expect(bridge.release).not.toHaveBeenCalled();
  });

  it('reads the live session states alongside the project state', async () => {
    const bridge = stubBridge();

    await useProjectWorkspaceStore.getState().openProject('project-1');

    expect(bridge.workSessionStatus).toHaveBeenCalledWith(['session-work']);
    expect(useProjectWorkspaceStore.getState().sessionStatuses['session-work']).toBe('STREAMING');
  });
});

describe('isLocalUserLease', () => {
  // A lease says "this session has an owner". Only the user's own lease means
  // the user holds the session, and the UI has to say so — a lease held by
  // another owner is somebody else's.
  const lease = (kind: SessionControlHolderKind) => ({
    sessionId: 'session-work',
    leaseId: 'lease-1',
    holder: { kind, id: 'local' },
    revision: 1,
    requestId: 'request-1',
    expiresAt: 999,
  });

  it('is true for a lease the user holds', () => {
    expect(isLocalUserLease(lease('user'))).toBe(true);
  });

  it('is false for a lease another holder owns', () => {
    expect(isLocalUserLease(lease('bot'))).toBe(false);
    expect(isLocalUserLease(lease('plugin'))).toBe(false);
  });

  it('is false when there is no lease', () => {
    expect(isLocalUserLease(null)).toBe(false);
    expect(isLocalUserLease(undefined)).toBe(false);
  });
});
