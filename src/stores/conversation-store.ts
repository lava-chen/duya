// conversation-store.ts - Zustand store for conversation/thread management

import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { Message, FileAttachment } from '@/types/message';
import {
  listThreadsIPC,
  getThreadIPC,
  createThreadIPC,
  deleteThreadIPC,
  getProjectGroupsIPC,
  getNoProjectWorkspaceIPC,
  addRecentFolderIPC,
  addMessageIPC,
  getActiveProviderIPC,
  updateThreadIPC,
  truncateMessagesAfterIPC,
  truncateMessagesFromInclusiveIPC,
  type Message as IpcMessage,
} from '@/lib/ipc-client';
import { getAgentServerClient } from '@/lib/agent-http-client';
import { useContextUsageStore } from '@/stores/context-usage-store';
import { registerLoadedMessages } from '@/lib/stream-session-manager';

// Thread interface - uses camelCase for frontend consistency
// generation is optional since older threads may not have it
export interface Thread {
  id: string;
  title: string;
  workingDirectory: string | null;
  projectName: string | null;
  createdAt: number;
  updatedAt: number;
  generation?: number;
  /** Provider ID for this thread */
  providerId?: string;
  /** Model name for this thread */
  model?: string;
  /** Parent session ID for sub-agent sessions */
  parentId?: string | null;
  /** Agent profile id (matches db: chat_sessions.agent_profile_id) */
  agentProfileId?: string | null;
  /** Agent type: 'main' | 'sub-agent' */
  agentType?: string;
  /** Agent name for display */
  agentName?: string;
  /** Conductor mode: 1 = enabled (canvas tools injected), 0 = disabled */
  conductorModeEnabled?: number;
  /** Conductor canvas ID bound to this session (when conductor mode is on) */
  conductorCanvasId?: string | null;
  /** Plan 413e: 1 = plan-task session toggle on (persisted to sessions.extensions.plan_mode_enabled), 0 = off */
  planModeEnabled?: number;
  /** Plan 413e: 1 = goal mode session toggle on (persisted to sessions.extensions.goal_mode_enabled), 0 = off */
  goalModeEnabled?: number;
  /** Plan 331 Phase 4: 1 = pinned to sidebar top, 0 = normal. */
  pinned?: number;
}

// Project group for sidebar display
export interface ProjectGroup {
  workingDirectory: string;
  projectName: string;
  threadCount: number;
  lastActivity: number;
  createdAt: number;
  isExpanded: boolean;
}

export type ProjectSortBy = 'priority' | 'lastActivity' | 'manual';
export type ProjectGroupBy = 'byProject' | 'singleList';

// View types for state-driven UI
export type ViewType = 'home' | 'chat' | 'settings' | 'skills' | 'bridge' | 'automation' | 'agents' | 'conductor' | 'extensions';
// Plan 205: sub-views inside the `providers` settings tab.
// `provider-picker` lists the preset cards; `provider-edit` shows
// the inline edit form for the chosen preset (create) or existing
// provider (edit). Both are pages inside the settings tab, not
// modals.
export type SettingsTab =
  | 'general' | 'appearance' | 'providers'
  | 'provider-picker' | 'provider-edit'
  | 'extensions' | 'channels' | 'browser' | 'security'
  | 'usage' | 'agents' | 'support' | 'memory' | 'hooks' | 'voice' | 'performance'
  | 'wake';

/**
 * Plan 205: the target of the `provider-edit` page. Either
 * `presetKey` is set (new provider) or `providerId` is set (edit
 * existing). The page reads this from the store and dispatches
 * the right flow.
 */
export interface ProviderEditTarget {
  /** New provider flow: which preset to prefill. */
  presetKey?: string;
  /** Edit existing provider flow. */
  providerId?: string;
}

/**
 * Persisted draft for a not-yet-created new chat. The user can type text
 * and attach files/images in the "new chat" composer without sending; the
 * draft survives navigation and app restarts (stored via zustand persist).
 * A real thread is only created when the user sends the message.
 */
export interface NewChatDraft {
  text: string;
  attachments: FileAttachment[];
  /** Whether the draft has any content (text or attachments). */
  hasContent: boolean;
}

/** Empty new-chat draft reused as the initial / cleared value. */
export const EMPTY_NEW_CHAT_DRAFT: NewChatDraft = {
  text: '',
  attachments: [],
  hasContent: false,
};

interface ConversationState {
  // View state for zero-router UI
  currentView: ViewType;
  settingsTab: SettingsTab;
  // View to restore when leaving settings; null when no snapshot was taken.
  previousView: ViewType | null;
  // Plan 205: the current provider edit target. Cleared on
  // navigation away from `provider-edit`.
  providerEditTarget: ProviderEditTarget | null;

  // Existing state
  threads: Thread[];
  activeThreadId: string | null;
  messages: Record<string, Message[]>;
  isHydrated: boolean;
  projects: ProjectGroup[];
  collapsedProjects: Set<string>;
  lastSyncAt: number; // Timestamp of last sync with database
  expandedThreads: Set<string>; // Thread IDs whose children are visible in sidebar
  parentSessionId: string | null; // Parent session ID when viewing a sub-agent
  projectSortBy: ProjectSortBy; // Sidebar project sort order
  projectGroupBy: ProjectGroupBy; // Sidebar project grouping mode
  /** Canonical path of the shared no-project workspace (~/.duya/workspace).
   *  Empty string until loaded from the backend. Sessions whose
   *  workingDirectory equals this value are grouped under "无项目". */
  noProjectWorkspace: string;

  // Plan: lazy new-chat draft. Clicking "new chat" only opens an empty
  // composer (no real thread). Text + attachments are kept in a global
  // draft that survives navigation and restarts (persisted below). A real
  // thread is created and shown in the sidebar only when the user sends.
  newChatDraft: NewChatDraft;
  /** True while the "new chat" composer is open with no backing thread. */
  isNewChatDrafting: boolean;
  /** Project preselected for the next new-chat composer (from a project-group
   *  "new thread" entry). Consumed by NewChatView as its initial project. */
  newChatPresetProject: { workingDirectory: string; projectName: string } | null;

  // Actions
  setCurrentView: (view: ViewType) => void;
  setSettingsTab: (tab: SettingsTab) => void;
  /** Plan 205: enter the provider edit page with the given target. */
  enterProviderEdit: (target: ProviderEditTarget) => void;
  /** Plan 205: clear the provider edit target on navigation away. */
  clearProviderEdit: () => void;
  enterSettings: () => void;
  exitSettings: () => void;
  createThread: (options?: { workingDirectory?: string; projectName?: string; providerId?: string; model?: string; noProject?: boolean; agentProfileId?: string | null }) => Promise<Thread | null>;
  deleteThread: (id: string) => void;
  setActiveThread: (id: string) => void;
  goToParentSession: () => void;
  addMessage: (threadId: string, message: Message, options?: { persist?: boolean }) => void;
  clearMessages: (threadId: string) => void;
  rewindToMessage: (threadId: string, messageId: string) => Promise<{ restoredFiles?: string[] }>;
  /**
   * Edit-and-resend: delete the target user message AND everything after it
   * (inclusive), then reload. The caller is responsible for sending the new
   * (edited) message after this resolves.
   */
  deleteMessageAndAfter: (threadId: string, messageId: string) => Promise<{ restoredFiles?: string[] }>;
  updateThreadTitle: (id: string, title: string) => void;
  setThreadWorkingDirectory: (id: string, workingDirectory: string, projectName: string) => void;
  setThreadModel: (id: string, model: string, providerId?: string) => void;
  /** Update conductor mode binding on the thread (local + DB IPC). */
  setThreadConductorBinding: (id: string, enabled: boolean, canvasId: string | null) => void;
  /** Plan 413e: update the plan-task session toggle on the thread (local state only; DB persistence via session.setPlanMode IPC). */
  setThreadPlanMode: (id: string, enabled: boolean) => void;
  /** Plan 413e: update the goal mode session toggle on the thread (local state only; DB persistence via session.setGoalMode IPC). */
  setThreadGoalMode: (id: string, enabled: boolean) => void;
  /** Plan 331 Phase 4: pin/unpin a thread (local + DB IPC). Pinned threads
   *  surface to the top of the sidebar across restarts. */
  setThreadPinned: (id: string, pinned: boolean) => void;
  addProjectFolder: (workingDirectory: string) => Promise<ProjectGroup | null>;
  toggleProjectExpanded: (workingDirectory: string) => void;
  collapseAllProjects: () => void;
  expandAllProjects: () => void;
  setProjectSortBy: (sortBy: ProjectSortBy) => void;
  setProjectGroupBy: (groupBy: ProjectGroupBy) => void;
  toggleThreadExpanded: (threadId: string) => void;
  loadFromDatabase: () => Promise<void>;
  loadThreadMessages: (threadId: string, options?: { force?: boolean }) => Promise<void>;
  syncThreadToDatabase: (thread: Thread) => Promise<void>;
  /** @deprecated Plan 317: frontend no longer writes chat messages; the Agent worker is the authoritative writer. */
  syncMessageToDatabase: (threadId: string, message: Message) => Promise<void>;
  syncThreadTitleToDatabase: (id: string, title: string) => Promise<void>;
  forceSync: () => Promise<void>; // Force immediate sync with database

  // Lazy new-chat draft actions.
  /** Open the blank "new chat" composer (no thread yet). Restores any
   *  previously saved draft. */
  startNewChat: (project?: { workingDirectory: string; projectName: string } | null) => void;
  /** Consume (and clear) the preset project after NewChatView applied it. */
  clearNewChatPresetProject: () => void;
  /** Persist the in-progress draft (text + attachments). */
  updateNewChatDraft: (draft: NewChatDraft) => void;
  /** Clear the saved draft after a successful send. */
  clearNewChatDraft: () => void;
  /** Leave the new-chat composer without clearing the draft (e.g. the user
   *  navigated to an existing session). */
  exitNewChatDraft: () => void;
}

// BroadcastChannel for cross-tab synchronization
const SYNC_CHANNEL_NAME = 'duya-sync';
let syncChannel: BroadcastChannel | null = null;

// Initialize BroadcastChannel for browser environments
function getSyncChannel(): BroadcastChannel | null {
  if (typeof window === 'undefined') return null;
  if (!syncChannel) {
    try {
      syncChannel = new BroadcastChannel(SYNC_CHANNEL_NAME);
      console.log('[Sync] BroadcastChannel initialized');
    } catch (error) {
      // BroadcastChannel not supported
      console.log('[Sync] BroadcastChannel not supported:', error);
      return null;
    }
  }
  return syncChannel;
}

// Check if running in Electron
function isElectron(): boolean {
  return typeof window !== 'undefined' && !!window.electronAPI;
}

// Notify other windows/tabs about thread changes
function notifyThreadsChanged() {
  if (isElectron()) {
    // In Electron: use IPC for cross-window sync (BroadcastChannel causes duplicates in Electron)
    if (window.electronAPI?.sync?.notifyThreadsChanged) {
      window.electronAPI.sync.notifyThreadsChanged();
    }
  } else {
    // In browser: use BroadcastChannel for cross-tab sync
    const channel = getSyncChannel();
    if (channel) {
      channel.postMessage({ type: 'THREADS_CHANGED', timestamp: Date.now() });
    }
  }
}

/**
 * Window size used to bucket message timestamps for equality. Two user
 * messages sent within the same window that share role + content are
 * treated as the same logical message (id-independent). Smaller than a
 * second so sub-second SSE timing skew never produces a false miss;
 * larger than a second so a legitimate retry by the user seconds later
 * is preserved as a separate entry.
 */
export const OPTIMISTIC_DEDUPE_WINDOW_MS = 5_000;

/**
 * Stable identity for the optimistic-dedupe bucket: (role, content
 * shape, time-window). Two user messages that land in the same bucket
 * are the same logical send — the renderer and the agent worker may
 * have given them different UUIDs (renderer-side optimistic vs.
 * DB-assigned), but the user only typed once.
 *
 * Exported so both `mergeInFlightOptimisticMessages` (post-DB-load
 * merge) and `addMessage` (write-time dedupe) can share one definition
 * and never drift.
 */
export function optimisticBucketKey(m: Pick<Message, 'role' | 'content' | 'timestamp'>): string {
  const ts = typeof m.timestamp === 'number' ? m.timestamp : 0;
  return `${m.role}|${typeof m.content === 'string' ? m.content : 'blocks'}|${Math.round(ts / OPTIMISTIC_DEDUPE_WINDOW_MS)}`;
}

/**
 * True when a local user row and a persisted user row are the same logical
 * send. Content must match exactly; the timestamps only need to be within
 * `OPTIMISTIC_DEDUPE_WINDOW_MS` of each other.
 *
 * This is a real distance check rather than the bucket-index comparison that
 * `optimisticBucketKey` performs. Bucketing on `Math.round(ts / WINDOW)` has a
 * discontinuity at every window edge, so a DB row 1 ms away from its optimistic
 * twin lands in a *different* bucket whenever the pair straddles a multiple of
 * the window — and the optimistic copy then survives as a visible duplicate.
 */
function isSameLogicalUserSend(a: Message, b: Message): boolean {
  if (a.role !== 'user' || b.role !== 'user') return false;
  const ac = typeof a.content === 'string' ? a.content : null;
  const bc = typeof b.content === 'string' ? b.content : null;
  // Block-shaped content has no cheap structural identity; fall back to the
  // shared bucket key so behaviour is unchanged for that rare case.
  if (ac === null || bc === null) return optimisticBucketKey(a) === optimisticBucketKey(b);
  if (ac !== bc) return false;
  const at = typeof a.timestamp === 'number' ? a.timestamp : 0;
  const bt = typeof b.timestamp === 'number' ? b.timestamp : 0;
  return Math.abs(at - bt) <= OPTIMISTIC_DEDUPE_WINDOW_MS;
}

/**
 * Pure helper for `loadThreadMessages`'s streaming-session merge branch.
 *
 * Returns the merged list (DB rows + any user message that is genuinely still
 * local-only) plus counts for diagnostics. The DB rows always win.
 *
 * IMPORTANT — `local` is the WHOLE store transcript (`messages[threadId]`),
 * not just the in-flight optimistic send. Every row in it that the DB already
 * has must therefore be dropped, or the merge re-appends the conversation to
 * itself. Only user rows can legitimately be local-only: `addMessage` has
 * exactly two call sites (App.tsx send + tool-timeout retry) and both push a
 * user message, while assistant / tool / system content reaches the store
 * solely through DB rows and live assistant output renders from
 * StreamSessionManager's event cache instead of from here.
 *
 * Exported for unit testing; see conversation-store.mergeInFlight.test.ts.
 */
export function mergeInFlightOptimisticMessages(
  persisted: Message[],
  local: Message[],
): { merged: Message[]; droppedOptimistic: number; keptOptimistic: number } {
  const persistedUsers = persisted.filter((m) => m.role === 'user');
  const merged = [...persisted];
  let droppedOptimistic = 0;
  let keptOptimistic = 0;
  for (const m of local) {
    // Non-user local rows are always echoes of rows `persisted` already
    // contains. Appending them duplicated the entire transcript on every
    // forced reload of a streaming session, growing by one full copy per
    // reload until the run ended.
    if (m.role !== 'user') continue;
    if (persistedUsers.some((p) => isSameLogicalUserSend(p, m))) {
      droppedOptimistic++;
      continue;
    }
    keptOptimistic++;
    merged.push(m);
  }
  return { merged, droppedOptimistic, keptOptimistic };
}

/**
 * Pure write-time guard used by `addMessage`: returns true when
 * `candidate` should be dropped because `existing` already contains an
 * optimistic user message in the same content window. Mirrors the
 * dedupe rule used by `mergeInFlightOptimisticMessages` (DB rows win)
 * so both layers agree on what counts as "the same send".
 *
 * Non-user candidates and candidates without `metadata.optimistic` are
 * always considered unique (caller still wants to write them).
 */
export function isDuplicateOptimisticUser(
  existing: ReadonlyArray<Message>,
  candidate: Message,
): boolean {
  if (candidate.role !== 'user' || candidate.metadata?.optimistic !== true) return false;
  const newKey = optimisticBucketKey(candidate);
  return existing.some(
    (m) => m.role === 'user' && m.metadata?.optimistic === true && optimisticBucketKey(m) === newKey,
  );
}

function mapIpcMessagesToStore(messages: IpcMessage[]): Message[] {
  return messages.map((m) => ({
    id: m.id,
    role: m.role,
    content: m.content,
    displayContent: m.displayContent ?? undefined,
    name: m.name ?? undefined,
    tool_call_id: m.toolCallId ?? undefined,
    timestamp: m.createdAt,
    tokenUsage: m.tokenUsage
      ? (typeof m.tokenUsage === 'string'
          ? JSON.parse(m.tokenUsage)
          : m.tokenUsage)
      : undefined,
    msgType: (m.msgType || undefined) as Message['msgType'],
    thinking: m.thinking ?? undefined,
    toolName: m.toolName ?? undefined,
    toolInput: m.toolInput ?? undefined,
    parentToolCallId: m.parentToolCallId ?? undefined,
    vizSpec: m.vizSpec ?? undefined,
    status: m.status ?? undefined,
    seqIndex: m.seqIndex ?? undefined,
    durationMs: m.durationMs ?? undefined,
    subAgentId: m.subAgentId ?? undefined,
    attachments: m.attachments ?? undefined,
  }));
}

export const useConversationStore = create<ConversationState>()(
  persist(
    (set, get) => ({
      // View state
      currentView: 'home',
      settingsTab: 'general',
      previousView: null,
      providerEditTarget: null,

      // Existing state
      threads: [],
      activeThreadId: null,
      messages: {},
      isHydrated: false,
      projects: [],
      collapsedProjects: new Set<string>(),
      expandedThreads: new Set<string>(),
      parentSessionId: null,
      projectSortBy: 'lastActivity',
      projectGroupBy: 'byProject',
      noProjectWorkspace: '',
      newChatDraft: EMPTY_NEW_CHAT_DRAFT,
      isNewChatDrafting: false,
      newChatPresetProject: null,
      lastSyncAt: 0, // Initialize to 0 to force first sync

      setCurrentView: (view) => {
        // Navigating to another view (settings, skills, bridge, ...) while the
        // lazy new-chat composer is open should leave draft mode so the target
        // view actually renders. The unsent draft content is kept — it is
        // restored when the user clicks "new chat" again.
        set({ currentView: view, isNewChatDrafting: false });
      },
      setSettingsTab: (tab) => {
        // Legacy ids (plugins/skills/mcp) used to funnel into the extensions
        // page, and `extensions` itself was a settings tab before it was
        // promoted to a top-level view. None of them are settings tabs any
        // more, so map them to the default tab — otherwise a stale caller
        // (or restored persisted state) lands on a pane that renders nothing.
        const legacy: Record<string, SettingsTab> = {
          plugins: 'general',
          skills: 'general',
          mcp: 'general',
          extensions: 'general',
        };
        set({ settingsTab: legacy[tab] ?? tab });
      },
      enterProviderEdit: (target) =>
        set({ settingsTab: 'provider-edit', providerEditTarget: target }),
      clearProviderEdit: () => set({ providerEditTarget: null }),
      enterSettings: () => {
        const { currentView } = get();
        // Don't overwrite a still-valid snapshot if the user re-enters settings
        // from somewhere else (e.g. a settings link inside another view).
        if (currentView === 'settings') return;
        // Leaving the lazy new-chat composer must exit draft mode (same as
        // setCurrentView), otherwise App keeps rendering NewChatView over the
        // settings page. The unsent draft content is kept and restored when
        // the user clicks "new chat" again.
        set({ previousView: currentView, currentView: 'settings', isNewChatDrafting: false });
      },
      exitSettings: () => {
        const { previousView, activeThreadId } = get();
        // Default fallback: if no snapshot was taken, prefer 'chat' (which will
        // show WelcomeView when no thread is active) over the bare 'home' shell.
        const restored = previousView ?? (activeThreadId ? 'chat' : 'home');
        set({ currentView: restored, previousView: null });
      },

      createThread: async (options) => {
        const { threads, activeThreadId, noProjectWorkspace } = get();

        // Determine working directory: use provided, or fall back to active thread's
        let workingDirectory: string | null | undefined = options?.workingDirectory;
        let projectName: string | null | undefined = options?.projectName;

        // No-project session: pin to the shared ~/.duya/workspace.
        if (options?.noProject) {
          workingDirectory = noProjectWorkspace || (await getNoProjectWorkspaceIPC());
          projectName = null;
        }

        if (!workingDirectory && activeThreadId) {
          const activeThread = threads.find(t => t.id === activeThreadId);
          if (activeThread?.workingDirectory) {
            workingDirectory = activeThread.workingDirectory;
            projectName = activeThread.projectName;
          }
        }

        // If still no workingDirectory, return null to signal caller to prompt for folder selection
        if (!workingDirectory) {
          return null;
        }

        // Use provided providerId and model, or fall back to active provider.
        // Treat empty strings as "not provided" so the fallback triggers.
        let providerId = options?.providerId || undefined;
        let model = options?.model || undefined;
        const agentProfileId = options?.agentProfileId || null;

        // If not provided, get from active provider
        if (!providerId) {
          try {
            const activeProvider = await getActiveProviderIPC();
            if (activeProvider) {
              providerId = activeProvider.id;
              // Try to get default model from provider options.
              // Plan 209: prefer enabled_models[0], then defaultModel, then model.
              if (!model && activeProvider.options) {
                try {
                  const providerOptions = JSON.parse(activeProvider.options);
                  if (Array.isArray(providerOptions.enabled_models) && providerOptions.enabled_models.length > 0) {
                    model = providerOptions.enabled_models[0];
                  } else {
                    model = providerOptions.defaultModel || providerOptions.model;
                  }
                } catch {
                  // Ignore parse error
                }
              }
            }
          } catch {
            // Ignore error, will use defaults
          }
        }

        const now = Date.now();
        const thread: Thread = {
          id: crypto.randomUUID(),
          title: 'New Thread',
          workingDirectory,
          projectName: projectName ?? null,
          createdAt: now,
          updatedAt: now,
          providerId,
          model,
          agentProfileId,
        };

        set((state) => ({
          threads: [thread, ...state.threads],
          activeThreadId: thread.id,
          messages: {
            ...state.messages,
            [thread.id]: [],
          },
        }));

        // Sync to database asynchronously
        get().syncThreadToDatabase(thread);

        return thread;
      },

      deleteThread: (id) => {
        set((state) => {
          const { [id]: _, ...remainingMessages } = state.messages;
          const newThreads = state.threads.filter((t) => t.id !== id);
          const newActiveId =
            state.activeThreadId === id
              ? newThreads[0]?.id ?? null
              : state.activeThreadId;

          return {
            threads: newThreads,
            activeThreadId: newActiveId,
            messages: remainingMessages,
          };
        });

        // Sync deletion to database and notify other windows/tabs
        deleteThreadIPC(id)
          .then(() => {
            notifyThreadsChanged();
          })
          .catch(console.error);
      },

      setActiveThread: async (id) => {
        const startTime = performance.now();
        console.log(`[Store] setActiveThread START: ${id.slice(0, 8)}`);
        // Leaving the new-chat composer to open an existing session: keep the
        // draft (so the user can resume it later) but exit draft mode.
        set({ isNewChatDrafting: false });
        let thread = get().threads.find(t => t.id === id);
        console.log('[Store] Found in local threads:', !!thread, 'parentId:', thread?.parentId);

        // If thread not in local state, try to fetch from DB
        if (!thread) {
          console.log('[Store] Thread not in local, fetching from DB...');
          try {
            const result = await getThreadIPC(id);
            console.log('[Store] getThreadIPC result:', !!result);
            if (result) {
              thread = result.thread;
              console.log('[Store] Fetched thread parentId:', thread.parentId);
              // Add to local threads
              set((state) => ({
                threads: [result.thread, ...state.threads.filter(t => t.id !== id)]
              }));
            }
          } catch (err) {
            console.error('[Store] Failed to fetch thread from DB:', err);
          }
        }

        const parentId = thread?.parentId || null;
        console.log('[Store] Final parentId:', parentId);
        const updates: Partial<ConversationState> = { activeThreadId: id, currentView: 'chat', parentSessionId: parentId };

        // Auto-expand parent thread in sidebar when opening a sub-agent
        if (parentId) {
          const newExpanded = new Set(get().expandedThreads);
          newExpanded.add(parentId);
          updates.expandedThreads = newExpanded;
        }

        // Force reload threads from DB to show newly created sub-agent sessions in sidebar
        updates.lastSyncAt = 0;
        set(updates);

        // Refresh thread metadata first, then force-load the selected
        // session's transcript. Keeping this ordered avoids a race where
        // the broad DB refresh overwrites the active session messages with
        // an empty/stale map after loadThreadMessages has already finished.
        await get().loadFromDatabase();
        await get().loadThreadMessages(id, { force: true });
        console.log(`[Store] setActiveThread DONE: ${id.slice(0, 8)}, total=${(performance.now() - startTime).toFixed(1)}ms`);
      },

      goToParentSession: () => {
        const { parentSessionId } = get();
        if (parentSessionId) {
          set({ activeThreadId: parentSessionId, currentView: 'chat', parentSessionId: null });
          get().loadThreadMessages(parentSessionId);
        }
      },

      loadThreadMessages: async (threadId, options) => {
        const startTime = performance.now();
        console.log(`[Store] loadThreadMessages START: ${threadId.slice(0, 8)}`);
        try {
          // Detect whether the session is currently streaming. While streaming,
          // the Agent worker persists the user's message only after the turn
          // completes (appendMessages at stream end), so a forced DB reload
          // would otherwise drop the optimistic in-flight user message.
          let isStreaming = false;
          try {
            const status = await getAgentServerClient().getSessionStatus(threadId);
            if (status && status.status === 'STREAMING') {
              console.log(`[Store] Session is STREAMING: ${threadId.slice(0, 8)}`);
              isStreaming = true;
            }
          } catch {
            // Ignore - Agent Server may not be running
          }

          // For non-forced loads, skip the DB entirely for streaming sessions
          // to avoid duplicates from SSE events.
          if (isStreaming && !options?.force) {
            console.log(`[Store] Skipping DB load for STREAMING session: ${threadId.slice(0, 8)}`);
            return;
          }

          const dbStart = performance.now();
          const data = await getThreadIPC(threadId);
          console.log(`[Store] getThreadIPC DONE: ${threadId.slice(0, 8)}, messages=${data?.messages?.length ?? 0}, elapsed=${(performance.now() - dbStart).toFixed(1)}ms`);
          if (data) {
            let messages = mapIpcMessagesToStore(data.messages || []);
            const currentMessages = get().messages[threadId] ?? [];
            if (messages.length === 0 && currentMessages.length > 0) {
              console.warn(
                `[Store] loadThreadMessages preserved local messages because DB returned empty: ${threadId.slice(0, 8)}, local=${currentMessages.length}`,
              );
              return;
            }
            // Forced reload of a streaming session (e.g. switching back while
            // the agent is still working): merge back any local in-flight
            // messages (the optimistic user message) not yet in the DB so a
            // session switch doesn't wipe them from the UI.
            //
            // Dedupe is by (role, content, timestamp-window) rather than by id:
            // optimistic user messages carry a client-generated UUID
            // (App.tsx crypto.randomUUID()), but the Agent worker may
            // re-assign a different UUID on persistence, so an id-only
            // diff would let the same optimistic+DB pair slip through
            // and render the user message twice. Only user-role optimistic
            // entries are eligible for dedupe; assistant/tool blocks are
            // handled by registerLoadedMessages below.
            if (isStreaming && currentMessages.length > 0) {
              const { merged, droppedOptimistic, keptOptimistic } =
                mergeInFlightOptimisticMessages(messages, currentMessages);
              messages = merged;
              if (keptOptimistic > 0) {
                console.log(
                  `[Store] Kept ${keptOptimistic} optimistic in-flight user message(s) for STREAMING session: ${threadId.slice(0, 8)}`,
                );
              }
              if (droppedOptimistic > 0) {
                console.log(
                  `[Store] Dropped ${droppedOptimistic} duplicate optimistic user message(s) already in DB: ${threadId.slice(0, 8)}`,
                );
              }
            }
            const threadData = data.thread;
            const mapEnd = performance.now();
            console.log(`[Store] messages MAPPED: ${threadId.slice(0, 8)}, count=${messages.length}, elapsed=${(mapEnd - dbStart).toFixed(1)}ms`);

            set((state) => {
              // Update thread's generation if provided
              const updatedThreads = threadData?.generation !== undefined
                ? state.threads.map(t =>
                    t.id === threadId ? { ...t, generation: threadData.generation } : t
                  )
                : state.threads;

              return {
                messages: {
                  ...state.messages,
                  [threadId]: messages,
                },
                threads: updatedThreads,
              };
            });
            // Register loaded messages with stream-session-manager to deduplicate
            // tool_use/tool_result from SSE reconnection after page refresh
            registerLoadedMessages(threadId, data.messages);
            console.log(`[Store] loadThreadMessages DONE: ${threadId.slice(0, 8)}, total=${(performance.now() - startTime).toFixed(1)}ms`);
          }
        } catch (error) {
          console.error('[Store] Failed to load thread messages:', error);
        }
      },

      addMessage: (threadId, message, options) => {
        let shouldUpdateTitle = false;
        let titlePreview = '';

        // Plan 4XX: write-time dedupe for optimistic user messages.
        //
        // `addMessage` is unconditional append — every send, every retry
        // callback, every hook re-fire pushes another row into
        // `messages[threadId]`. The downstream merge branch in
        // `loadThreadMessages` only runs when a caller passes `{ force:
        // true }` AND the session is mid-stream; for a normal renderer-
        // initiated run, neither is true while the agent is still
        // working, so duplicates stacked in local state survive until
        // the run ends (where the user can see them render 7+ times in
        // a row). Bail out at write time using the same bucket that the
        // post-DB-load merge uses, so both layers can never disagree.
        if (isDuplicateOptimisticUser(get().messages[threadId] ?? [], message)) {
          console.log(`[Store] addMessage dropped duplicate optimistic user message: ${threadId.slice(0, 8)}`);
          return;
        }

        set((state) => {
          const threadMessages = state.messages[threadId] ?? [];
          const updatedMessages = {
            ...state.messages,
            [threadId]: [...threadMessages, message],
          };

          // Update thread's updatedAt
          const updatedThreads = state.threads.map((t) =>
            t.id === threadId ? { ...t, updatedAt: Date.now() } : t
          );

          // Auto-update thread title from first user message
          let updatedTitleThreads = updatedThreads;
          if (message.role === 'user' && threadMessages.length === 0) {
            titlePreview =
              message.content.slice(0, 40) +
              (message.content.length > 40 ? '...' : '');
            updatedTitleThreads = updatedThreads.map((t) =>
              t.id === threadId ? { ...t, title: titlePreview } : t
            );
            shouldUpdateTitle = true;
          }

          return {
            messages: updatedMessages,
            threads: updatedTitleThreads,
          };
        });

        // Sync title update to database if this is the first user message
        if (shouldUpdateTitle && titlePreview) {
          const thread = get().threads.find((t) => t.id === threadId);
          if (thread) {
            get().syncThreadToDatabase({ ...thread, title: titlePreview });
          }
        }

        // User messages are persisted by the Agent worker (authoritative write
        // path); the frontend only renders optimistically. `persist: true` is
        // never used in the chat flow (Plan 317), so no frontend DB write here.
      },

      clearMessages: (threadId) => {
        set((state) => ({
          messages: {
            ...state.messages,
            [threadId]: [],
          },
        }));
      },

      rewindToMessage: async (threadId, messageId) => {
        const result = await truncateMessagesAfterIPC(threadId, messageId);
        if (result.deletedCount === 0) return {};
        // History shrank: the live snapshot describes the pre-rewind
        // context, so drop it and let the reloaded messages (or the next
        // turn's token_usage) drive the ring.
        useContextUsageStore.getState().clearLive(threadId);
        set((state) => ({
          messages: { ...state.messages, [threadId]: [] },
        }));
        await get().loadThreadMessages(threadId);
        // Plan 429 #3: surface how many files were rolled back to their
        // pre-image so the UI can tell the user what happened on disk.
        return { restoredFiles: result.restoredFiles };
      },

      deleteMessageAndAfter: async (threadId, messageId) => {
        const result = await truncateMessagesFromInclusiveIPC(threadId, messageId);
        if (result.deletedCount === 0) return {};
        // History shrank — same invalidation as rewindToMessage.
        useContextUsageStore.getState().clearLive(threadId);
        set((state) => ({
          messages: { ...state.messages, [threadId]: [] },
        }));
        await get().loadThreadMessages(threadId);
        return { restoredFiles: result.restoredFiles };
      },

      updateThreadTitle: (id, title) => {
        set((state) => ({
          threads: state.threads.map((t) =>
            t.id === id ? { ...t, title, updatedAt: Date.now() } : t
          ),
        }));

        // Sync title update to database using updateThreadIPC
        const thread = get().threads.find((t) => t.id === id);
        if (thread) {
          get().syncThreadTitleToDatabase(id, title);
        }
      },

      setThreadWorkingDirectory: (id, workingDirectory, projectName) => {
        set((state) => ({
          threads: state.threads.map((t) =>
            t.id === id
              ? { ...t, workingDirectory, projectName, updatedAt: Date.now() }
              : t
          ),
        }));

        // Sync to database
        const thread = get().threads.find((t) => t.id === id);
        if (thread) {
          get().syncThreadToDatabase(thread);
        }
      },

      setThreadModel: (id, model, providerId) => {
        set((state) => ({
          threads: state.threads.map((t) =>
            t.id === id
              ? {
                  ...t,
                  model,
                  // Only overwrite providerId when the caller supplies one
                  // (e.g. the model picker knows the new provider). When
                  // omitted we leave the existing providerId untouched so
                  // a model-only reload from DB doesn't drop the binding.
                  providerId: providerId ?? t.providerId,
                  updatedAt: Date.now(),
                }
              : t
          ),
        }));

        // Sync to database
        const thread = get().threads.find((t) => t.id === id);
        if (thread) {
          get().syncThreadToDatabase(thread);
        }
      },

      setThreadConductorBinding: (id, enabled, canvasId) => {
        set((state) => ({
          threads: state.threads.map((t) =>
            t.id === id
              ? {
                  ...t,
                  conductorModeEnabled: enabled ? 1 : 0,
                  conductorCanvasId: canvasId,
                  updatedAt: Date.now(),
                }
              : t
          ),
        }));
        // DB persistence is handled by the caller via session.setConductorMode IPC.
      },

      setThreadPlanMode: (id, enabled) => {
        set((state) => ({
          threads: state.threads.map((t) =>
            t.id === id
              ? {
                  ...t,
                  planModeEnabled: enabled ? 1 : 0,
                  updatedAt: Date.now(),
                }
              : t
          ),
        }));
        // DB persistence is handled by the caller via session.setPlanMode IPC.
      },

      setThreadGoalMode: (id, enabled) => {
        set((state) => ({
          threads: state.threads.map((t) =>
            t.id === id
              ? {
                  ...t,
                  goalModeEnabled: enabled ? 1 : 0,
                  updatedAt: Date.now(),
                }
              : t
          ),
        }));
        // DB persistence is handled by the caller via session.setGoalMode IPC.
      },

      setThreadPinned: (id, pinned) => {
        set((state) => ({
          threads: state.threads.map((t) =>
            t.id === id ? { ...t, pinned: pinned ? 1 : 0 } : t
          ),
        }));
        // Persist to sessions.extensions.pinned via the dedicated IPC.
        // Fire-and-forget — the local state update is optimistic; a failure
        // here only means the pin won't survive a restart, which is an
        // acceptable degradation for a UI convenience feature.
        if (window.electronAPI?.session?.setPinned) {
          window.electronAPI.session.setPinned(id, pinned).catch((err) => {
            console.error('[Store] Failed to persist pinned state:', err);
            // Revert local state on failure so the UI stays truthful.
            set((state) => ({
              threads: state.threads.map((t) =>
                t.id === id ? { ...t, pinned: pinned ? 0 : 1 } : t
              ),
            }));
          });
        }
      },

      addProjectFolder: async (workingDirectory) => {
        const trimmed = workingDirectory.trim();
        if (!trimmed) return null;

        const projectName = trimmed.split(/[\\/]/).pop() || 'Untitled';
        const projects = (await addRecentFolderIPC(trimmed)).map((p) => ({
          ...p,
          createdAt: p.createdAt ?? p.lastActivity ?? Date.now(),
          isExpanded: true,
        }));
        const project = projects.find((p) => p.workingDirectory === trimmed) ?? {
          workingDirectory: trimmed,
          projectName,
          threadCount: 0,
          lastActivity: Date.now(),
          createdAt: Date.now(),
          isExpanded: true,
        };

        set({ projects });
        return project;
      },

      toggleProjectExpanded: (workingDirectory) => {
        set((state) => {
          const newCollapsed = new Set(state.collapsedProjects);
          if (newCollapsed.has(workingDirectory)) {
            newCollapsed.delete(workingDirectory);
          } else {
            newCollapsed.add(workingDirectory);
          }
          return { collapsedProjects: newCollapsed };
        });
      },

      collapseAllProjects: () => {
        set((state) => {
          const newCollapsed = new Set(state.collapsedProjects);
          for (const project of state.projects) {
            newCollapsed.add(project.workingDirectory);
          }
          // Cron sidebar group shares the collapse state under a reserved key.
          newCollapsed.add('__cron__');
          return { collapsedProjects: newCollapsed };
        });
      },

      expandAllProjects: () => {
        set((state) => {
          const newCollapsed = new Set(state.collapsedProjects);
          for (const project of state.projects) {
            newCollapsed.delete(project.workingDirectory);
          }
          newCollapsed.delete('__cron__');
          return { collapsedProjects: newCollapsed };
        });
      },

      setProjectSortBy: (sortBy) => set({ projectSortBy: sortBy }),

      setProjectGroupBy: (groupBy) => set({ projectGroupBy: groupBy }),

      toggleThreadExpanded: (threadId) => {
        set((state) => {
          const newExpanded = new Set(state.expandedThreads);
          if (newExpanded.has(threadId)) {
            newExpanded.delete(threadId);
          } else {
            newExpanded.add(threadId);
          }
          return { expandedThreads: newExpanded };
        });
      },

      loadFromDatabase: async () => {
        const { lastSyncAt, isHydrated } = get();
        const now = Date.now();
        const STALE_TIME = 30000;

        if (isHydrated && lastSyncAt > 0 && now - lastSyncAt < STALE_TIME) {
          return;
        }

        try {
          const dbThreads = await listThreadsIPC();
          // Filter out gateway sessions (gw- prefix) - they are managed separately in the Gateway Dashboard
          const filteredThreads = dbThreads.filter(t => !t.id.startsWith('gw-'));

          // Detect new child threads to auto-expand their parents
          const existingThreads = get().threads;
          const existingChildParentIds = new Set(
            existingThreads.filter(t => t.parentId).map(t => t.parentId!)
          );

          // Merge with existing threads: use database as source of truth
          // but preserve any local threads that haven't been synced yet
          const dbThreadIds = new Set(filteredThreads.map((t) => t.id));

          // Keep local threads that don't exist in DB yet (pending sync)
          const pendingThreads = existingThreads.filter(t => !dbThreadIds.has(t.id));

          // Detect new child threads from DB
          const newChildParentIds: string[] = [];
          for (const t of filteredThreads) {
            if (t.parentId && !existingChildParentIds.has(t.parentId)) {
              newChildParentIds.push(t.parentId);
            }
          }

          // Merge: DB threads + pending local threads
          const mergedThreads: Thread[] = [...filteredThreads, ...pendingThreads].sort(
            (a, b) => b.updatedAt - a.updatedAt
          );

          // Preserve loaded transcripts during broad metadata refreshes.
          // Loading every thread's full transcript here made session
          // switches slow and could overwrite the active session with an
          // empty/stale map. Only hydrate the active session when needed;
          // individual navigation still calls loadThreadMessages().
          const messages: Record<string, Message[]> = { ...get().messages };
          let activeThreadId = get().activeThreadId;
          if (activeThreadId && dbThreadIds.has(activeThreadId) && messages[activeThreadId] === undefined) {
            const threadData = await getThreadIPC(activeThreadId);
            if (threadData) {
              messages[activeThreadId] = mapIpcMessagesToStore(threadData.messages || []);
              registerLoadedMessages(activeThreadId, threadData.messages);
            }
          } else if (activeThreadId && !dbThreadIds.has(activeThreadId)) {
            // Persisted activeThreadId no longer exists in the DB (deleted,
            // migrated, or orphaned by an older config). Clearing it here
            // prevents the boot-splash watchdog in App.tsx from force-
            // dismissing 5s later; the user lands on the welcome screen and
            // can navigate to any other thread from the sidebar.
            console.warn(
              `[Store] Clearing orphaned activeThreadId: ${activeThreadId.slice(0, 8)} (not in DB)`,
            );
            activeThreadId = null;
          }

          // Load projects (already converted to camelCase by getProjectGroupsIPC)
          const projects: ProjectGroup[] = (await getProjectGroupsIPC()).map((p) => ({
            ...p,
            createdAt: p.createdAt ?? p.lastActivity ?? Date.now(),
            isExpanded: true,
          }));

          // Load the canonical no-project workspace path so the sidebar can
          // route no-project sessions into the "无项目" group.
          const noProjectWorkspace = await getNoProjectWorkspaceIPC();

          set({
            threads: mergedThreads,
            messages,
            activeThreadId,
            projects,
            noProjectWorkspace,
            lastSyncAt: now,
            isHydrated: true,
            ...(newChildParentIds.length > 0 ? {
              expandedThreads: new Set([...get().expandedThreads, ...newChildParentIds])
            } : {}),
          });
        } catch (error) {
          console.error('[Store] Failed to load from database:', error);
          // On error, keep existing data but mark as hydrated. The catch
          // path is intentionally conservative: we do NOT clear the
          // persisted activeThreadId here because the failure may be
          // transient (one of the IPC calls threw), and the user's intent
          // (their last open thread) is more important than recovering a
          // possibly-orphaned ID. The success path above handles the
          // orphan case explicitly; here we just unblock the boot splash.
          set({ isHydrated: true });
        }
      },

      forceSync: async () => {
        // Reset lastSyncAt to force immediate reload
        set({ lastSyncAt: 0 });
        await get().loadFromDatabase();
      },

      startNewChat: (project) => {
        set({
          isNewChatDrafting: true,
          activeThreadId: null,
          currentView: 'chat',
          parentSessionId: null,
          newChatPresetProject: project ?? null,
        });
      },

      clearNewChatPresetProject: () => {
        set({ newChatPresetProject: null });
      },

      updateNewChatDraft: (draft) => {
        set({ newChatDraft: draft });
      },

      clearNewChatDraft: () => {
        set({ newChatDraft: EMPTY_NEW_CHAT_DRAFT });
      },

      exitNewChatDraft: () => {
        set({ isNewChatDrafting: false });
      },

      syncThreadToDatabase: async (thread) => {
        try {
          await createThreadIPC({
            id: thread.id,
            title: thread.title,
            workingDirectory: thread.workingDirectory ?? undefined,
            projectName: thread.projectName ?? undefined,
            model: thread.model,
            providerId: thread.providerId,
          });
          // Notify other windows/tabs after successful sync
          notifyThreadsChanged();
        } catch (error) {
          console.error('[Store] Failed to sync thread to database:', error);
        }
      },

      /** @deprecated Plan 317: frontend no longer writes chat messages. */
      syncMessageToDatabase: async (threadId, message) => {
        try {
          await addMessageIPC({
            id: message.id,
            sessionId: threadId,
            role: message.role,
            content: typeof message.content === 'string' ? message.content : JSON.stringify(message.content),
            name: message.name,
            toolCallId: message.tool_call_id,
            tokenUsage: message.tokenUsage ? JSON.stringify(message.tokenUsage) : undefined,
            msgType: message.msgType,
            thinking: message.thinking,
            toolName: message.toolName,
            toolInput: message.toolInput,
            parentToolCallId: message.parentToolCallId,
            vizSpec: message.vizSpec,
            status: message.status,
            seqIndex: message.seqIndex,
            durationMs: message.durationMs,
            subAgentId: message.subAgentId,
            attachments: message.attachments,
          });
        } catch (error) {
          console.error('[Store] Failed to sync message to database:', error);
        }
      },

      syncThreadTitleToDatabase: async (id, title) => {
        try {
          await updateThreadIPC(id, { title });
          // Notify other windows/tabs after successful sync
          notifyThreadsChanged();
        } catch (error) {
          console.error('[Store] Failed to sync thread title to database:', error);
        }
      },
    }),
    {
      name: 'duya-conversations',
      partialize: (state) => ({
        // View state
        currentView: state.currentView,
        settingsTab: state.settingsTab,
        // Threads are NOT persisted to localStorage anymore
        // They are always loaded from SQLite database to ensure consistency
        // across multiple browser tabs/windows
        activeThreadId: state.activeThreadId,
        // Messages are NOT persisted here - they're stored in SQLite
        // Persisting only UI state
        collapsedProjects: Array.from(state.collapsedProjects),
        expandedThreads: Array.from(state.expandedThreads),
        projectSortBy: state.projectSortBy,
        projectGroupBy: state.projectGroupBy,
        lastSyncAt: state.lastSyncAt,
        // Persist the new-chat draft so unsent text + attachments survive
        // navigation and app restarts. `isNewChatDrafting` is intentionally
        // NOT persisted — it's a session-scoped UI flag.
        newChatDraft: state.newChatDraft,
      }),
      onRehydrateStorage: () => (state) => {
        // Mark hydration complete and restore collapsedProjects Set
        if (state) {
          const s = state as ConversationState;
          s.isHydrated = true;
          if (Array.isArray(s.collapsedProjects)) {
            s.collapsedProjects = new Set(s.collapsedProjects as unknown as string[]);
          }
          if (Array.isArray(s.expandedThreads)) {
            s.expandedThreads = new Set(s.expandedThreads as unknown as string[]);
          }
          // Ensure lastSyncAt is initialized
          if (!s.lastSyncAt) {
            s.lastSyncAt = 0;
          }
          // Normalize a persisted draft (older saves may lack `hasContent` or
          // `attachments`). Derive `hasContent` so the composer can detect a
          // non-empty draft reliably.
          if (!s.newChatDraft || typeof s.newChatDraft !== 'object') {
            s.newChatDraft = EMPTY_NEW_CHAT_DRAFT;
          } else {
            const d = s.newChatDraft;
            d.text = typeof d.text === 'string' ? d.text : '';
            d.attachments = Array.isArray(d.attachments) ? d.attachments : [];
            d.hasContent = d.text.trim().length > 0 || d.attachments.length > 0;
          }
          // Migrate old sort/group state to the new model
          const legacySort = s.projectSortBy as unknown as string;
          if (legacySort === 'createdAt') {
            s.projectSortBy = 'priority';
          } else if (legacySort === 'name') {
            s.projectSortBy = 'manual';
          } else if (!['priority', 'lastActivity', 'manual'].includes(legacySort)) {
            s.projectSortBy = 'lastActivity';
          }
          const legacyGroup = (s as unknown as Record<string, unknown>).projectFilter as string | undefined;
          if (legacyGroup && !s.projectGroupBy) {
            s.projectGroupBy = 'byProject';
          }
          if (!['byProject', 'singleList'].includes(s.projectGroupBy)) {
            s.projectGroupBy = 'byProject';
          }
        }
      },
    }
  )
);

// Handle sync event from other tabs/windows (and main-process broadcasts such
// as a scheduled cron run creating a session). Always forceSync: the event
// means "the sessions table changed", and loadFromDatabase only hydrates the
// active session's transcript when it has never been loaded, so an in-flight
// stream and its optimistic messages are untouched — only the sidebar list
// (including the cron group) refreshes.
function handleSyncEvent(source: string) {
  console.log(`[Sync] Received sync event from ${source}`);
  useConversationStore.getState().forceSync();
}

// Subscribe to sync events from other tabs/windows
if (typeof window !== 'undefined') {
  if (isElectron()) {
    // In Electron: listen via IPC
    if (window.electronAPI?.sync?.onThreadsChanged) {
      window.electronAPI.sync.onThreadsChanged(() => {
        handleSyncEvent('Electron IPC');
      });
    }
  } else {
    // In browser: listen via BroadcastChannel
    const channel = getSyncChannel();
    if (channel) {
      channel.onmessage = (event) => {
        if (event.data.type === 'THREADS_CHANGED') {
          handleSyncEvent('BroadcastChannel');
        }
      };
    }
  }
}
