/**
 * project-workspace-store.ts — the renderer cache for the Project-first view.
 *
 * ## What this store is
 *
 * One project, seen as one thing: its coordinator conversation, its tasks and
 * its working sessions, plus who currently holds each working session.
 *
 * The data comes from ONE Host read (`projects:state`). That is deliberate:
 * the view shows a coordinator, a task list and a session list side by side,
 * and if those came from separate calls the view could show a coordinator
 * that disagrees with the task bound to it — a picture that never existed.
 *
 * ## The lease is the arbitration authority
 *
 * A working session belongs to the project, but the USER may take one over to
 * work in it directly. While the user holds the lease, the Coordinator may
 * watch the session but may not instruct it. So the lease — not a local flag —
 * decides who may direct a session, and this store only asks the Host about
 * it.
 *
 * Read-only by default: opening a working session does NOT take it over. The
 * user asks for it explicitly, and gives it back explicitly.
 */

import { create } from 'zustand';
import { useConversationStore } from '@/stores/conversation-store';
import type {
  HostProjectRecord,
  HostProjectState,
  HostProjectTaskState,
  HostProjectWorkSession,
  SessionControlLease,
} from '@duya/agent-protocol';

export interface ProjectWorkspaceSnapshot {
  project: HostProjectRecord;
  coordinatorSessionId: string | null;
  tasks: readonly HostProjectTaskState[];
  workSessions: readonly HostProjectWorkSession[];
  observedAt: number;
}

/**
 * Whether the lease is the LOCAL user's.
 *
 * A lease says "this session has an owner", not "the user has this session".
 * The Desktop grants leases to the local user, so a lease held by another
 * holder is one this surface does not own — and the UI must not tell the user
 * it is holding a session that somebody else holds.
 */
export function isLocalUserLease(lease: SessionControlLease | null | undefined): boolean {
  return lease?.holder.kind === 'user';
}

interface ProjectWorkspaceState {
  /** The project this view is showing. Null when no project is open. */
  activeProjectId: string | null;
  /** The last observed project state. Null until the first read lands. */
  snapshot: ProjectWorkspaceSnapshot | null;
  /** The live state of each working session, keyed by session id. */
  sessionStatuses: Record<string, string>;
  /** The control lease of each working session, keyed by session id. */
  leases: Record<string, SessionControlLease | null>;
  loading: boolean;
  error: string | null;

  /** Open a project: read its state and make sure it has a coordinator. */
  openProject: (projectId: string) => Promise<void>;
  /**
   * Open a project and return its coordinator conversation.
   *
   * The coordinator is created on first use, so a project the user has never
   * entered still opens onto a conversation instead of an empty page.
   */
  enterProject: (projectId: string) => Promise<string | null>;
  /** Re-read the project state and the live session states. */
  refresh: () => Promise<void>;
  /** The project's coordinator conversation, created on first use. */
  ensureCoordinator: () => Promise<string | null>;
  /** Read the live state of the given working sessions. */
  refreshSessionStatuses: (sessionIds: readonly string[]) => Promise<void>;
  /** Read the control lease of a working session, without taking it. */
  readLease: (sessionId: string) => Promise<SessionControlLease | null>;
  /** Take a working session over. False means somebody else holds it. */
  acquireLease: (sessionId: string) => Promise<boolean>;
  /** Give a working session back to the project. */
  releaseLease: (sessionId: string) => Promise<boolean>;
}

/**
 * The bridge, or null when the surface has no Desktop bridge.
 *
 * The Desktop is the only surface with this window today; a browser that
 * mounts the shared renderer simply has no project workspace, and says so
 * rather than showing an empty project that looks like a real one.
 */
function bridge(): Window['electronAPI']['projectWorkspace'] | null {
  return window.electronAPI?.projectWorkspace ?? null;
}

export const useProjectWorkspaceStore = create<ProjectWorkspaceState>((set, get) => ({
  activeProjectId: null,
  snapshot: null,
  sessionStatuses: {},
  leases: {},
  loading: false,
  error: null,

  openProject: async (projectId: string) => {
    // The navigation store owns WHICH project the user is in, and it is the
    // one that is persisted — so a restart lands the user back in the same
    // project instead of in a bare chat.
    useConversationStore.getState().setActiveProject(projectId);
    set({ activeProjectId: projectId, loading: true, error: null, sessionStatuses: {}, leases: {} });
    const api = bridge();
    if (!api) {
      set({ loading: false, error: 'This surface cannot reach the project workspace.' });
      return;
    }
    try {
      const result = await api.state(projectId);
      if (!result.success) {
        set({ loading: false, error: result.error });
        return;
      }
      if (!result.state) {
        set({ snapshot: null, loading: false, error: `Project "${projectId}" no longer exists.` });
        return;
      }
      set({
        snapshot: {
          project: result.state.project,
          coordinatorSessionId: result.state.coordinatorSessionId,
          tasks: result.state.tasks,
          workSessions: result.state.workSessions,
          observedAt: result.state.observedAt,
        },
        loading: false,
        error: null,
      });
      await get().refreshSessionStatuses(result.state.workSessions.map((s) => s.sessionId));
    } catch (error) {
      set({ loading: false, error: error instanceof Error ? error.message : String(error) });
    }
  },

  enterProject: async (projectId: string) => {
    await get().openProject(projectId);
    return get().ensureCoordinator();
  },

  refresh: async () => {
    const projectId = get().activeProjectId;
    if (!projectId) return;
    await get().openProject(projectId);
  },

  ensureCoordinator: async () => {
    const projectId = get().activeProjectId;
    const api = bridge();
    if (!projectId || !api) return null;
    try {
      const result = await api.ensureCoordinator(projectId);
      if (!result.success) {
        set({ error: result.error });
        return null;
      }
      // The coordinator binding changed, so the state we hold is stale.
      await get().refresh();
      return result.sessionId;
    } catch (error) {
      set({ error: error instanceof Error ? error.message : String(error) });
      return null;
    }
  },

  refreshSessionStatuses: async (sessionIds: readonly string[]) => {
    const api = bridge();
    if (!api || sessionIds.length === 0) return;
    try {
      const result = await api.workSessionStatus(sessionIds);
      if (!result.success) return;
      set((state) => ({ sessionStatuses: { ...state.sessionStatuses, ...result.statuses } }));
    } catch {
      // A status read that fails leaves the previous states in place. The
      // panel renders "unknown" for a session it has no state for, which is
      // the truth — not a crash over a progress column.
    }
  },

  readLease: async (sessionId: string) => {
    const api = bridge();
    if (!api) return null;
    try {
      const result = await api.lease.get(sessionId);
      if (!result.success) return null;
      set((state) => ({ leases: { ...state.leases, [sessionId]: result.lease } }));
      return result.lease;
    } catch {
      return null;
    }
  },

  acquireLease: async (sessionId: string) => {
    const api = bridge();
    if (!api) return false;
    try {
      const result = await api.lease.acquire(sessionId, crypto.randomUUID());
      if (!result.success) {
        set({ error: result.error });
        return false;
      }
      if (!result.lease) {
        // Somebody else holds it. That is an ordinary answer, and the caller
        // has to say so rather than pretend the takeover happened.
        set((state) => ({ leases: { ...state.leases, [sessionId]: null } }));
        return false;
      }
      set((state) => ({ leases: { ...state.leases, [sessionId]: result.lease } }));
      return true;
    } catch (error) {
      set({ error: error instanceof Error ? error.message : String(error) });
      return false;
    }
  },

  releaseLease: async (sessionId: string) => {
    const api = bridge();
    const lease = get().leases[sessionId];
    if (!api || !lease) return false;
    try {
      const result = await api.lease.release(sessionId, lease.revision);
      if (!result.success) {
        set({ error: result.error });
        return false;
      }
      set((state) => ({ leases: { ...state.leases, [sessionId]: null } }));
      return result.released;
    } catch (error) {
      set({ error: error instanceof Error ? error.message : String(error) });
      return false;
    }
  },
}));
