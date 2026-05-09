// conversation-store.ts - Zustand store for conversation/thread management

import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { Message } from '@/types/message';
import {
  listThreadsIPC,
  getThreadIPC,
  createThreadIPC,
  deleteThreadIPC,
  getProjectGroupsIPC,
  addMessageIPC,
  getActiveProviderIPC,
} from '@/lib/ipc-client';

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
  /** Agent type: 'main' | 'sub-agent' */
  agentType?: string;
  /** Agent name for display */
  agentName?: string;
}

// Project group for sidebar display
export interface ProjectGroup {
  workingDirectory: string;
  projectName: string;
  threadCount: number;
  lastActivity: number;
  isExpanded: boolean;
}

// View types for state-driven UI
export type ViewType = 'home' | 'chat' | 'settings' | 'skills' | 'bridge' | 'automation' | 'agents' | 'conductor';
export type SettingsTab = 'general' | 'appearance' | 'providers' | 'skills' | 'mcp' | 'channels' | 'browser' | 'security' | 'usage' | 'agents' | 'support';

interface ConversationState {
  // View state for zero-router UI
  currentView: ViewType;
  settingsTab: SettingsTab;

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

  // Actions
  setCurrentView: (view: ViewType) => void;
  setSettingsTab: (tab: SettingsTab) => void;
  createThread: (options?: { workingDirectory?: string; projectName?: string; providerId?: string; model?: string }) => Promise<Thread | null>;
  deleteThread: (id: string) => void;
  setActiveThread: (id: string) => void;
  goToParentSession: () => void;
  addMessage: (threadId: string, message: Message) => void;
  clearMessages: (threadId: string) => void;
  updateThreadTitle: (id: string, title: string) => void;
  setThreadWorkingDirectory: (id: string, workingDirectory: string, projectName: string) => void;
  toggleProjectExpanded: (workingDirectory: string) => void;
  toggleThreadExpanded: (threadId: string) => void;
  loadFromDatabase: () => Promise<void>;
  loadThreadMessages: (threadId: string) => Promise<void>;
  syncThreadToDatabase: (thread: Thread) => Promise<void>;
  syncMessageToDatabase: (threadId: string, message: Message) => Promise<void>;
  forceSync: () => Promise<void>; // Force immediate sync with database
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

export const useConversationStore = create<ConversationState>()(
  persist(
    (set, get) => ({
      // View state
      currentView: 'home',
      settingsTab: 'general',

      // Existing state
      threads: [],
      activeThreadId: null,
      messages: {},
      isHydrated: false,
      projects: [],
      collapsedProjects: new Set<string>(),
      expandedThreads: new Set<string>(),
      parentSessionId: null,
      lastSyncAt: 0, // Initialize to 0 to force first sync

      setCurrentView: (view) => set({ currentView: view }),
      setSettingsTab: (tab) => set({ settingsTab: tab }),

      createThread: async (options) => {
        const { threads, activeThreadId } = get();

        // Determine working directory: use provided, or fall back to active thread's
        let workingDirectory: string | null | undefined = options?.workingDirectory;
        let projectName: string | null | undefined = options?.projectName;

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

        // Use provided providerId and model, or fall back to active provider
        let providerId = options?.providerId;
        let model = options?.model;

        // If not provided, get from active provider
        if (!providerId) {
          try {
            const activeProvider = await getActiveProviderIPC();
            if (activeProvider) {
              providerId = activeProvider.id;
              // Try to get default model from provider options
              if (!model && activeProvider.options) {
                try {
                  const providerOptions = JSON.parse(activeProvider.options);
                  model = providerOptions.defaultModel || providerOptions.model;
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
        console.log('[Store] setActiveThread called:', id.slice(0, 8));
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
        
        // Load messages for this thread from database
        get().loadThreadMessages(id);
        
        // Always reload from DB to ensure we have latest data including sub-agents
        get().loadFromDatabase();
      },

      goToParentSession: () => {
        const { parentSessionId } = get();
        if (parentSessionId) {
          set({ activeThreadId: parentSessionId, currentView: 'chat', parentSessionId: null });
          get().loadThreadMessages(parentSessionId);
        }
      },

      loadThreadMessages: async (threadId) => {
        try {
          const data = await getThreadIPC(threadId);
          if (data) {
            // Convert IPC messages to store's expected format (timestamp instead of createdAt)
            const messages: Message[] = (data.messages || []).map((m) => ({
              id: m.id,
              role: m.role,
              content: m.content,
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
            }));
            const threadData = data.thread;

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
          }
        } catch (error) {
          console.error('[Store] Failed to load thread messages:', error);
        }
      },

      addMessage: (threadId, message) => {
        let shouldUpdateTitle = false;
        let titlePreview = '';

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

        // Sync user message to database immediately
        if (message.role === 'user') {
          get().syncMessageToDatabase(threadId, message);
        }
      },

      clearMessages: (threadId) => {
        set((state) => ({
          messages: {
            ...state.messages,
            [threadId]: [],
          },
        }));
      },

      updateThreadTitle: (id, title) => {
        set((state) => ({
          threads: state.threads.map((t) =>
            t.id === id ? { ...t, title, updatedAt: Date.now() } : t
          ),
        }));

        // Sync to database
        const thread = get().threads.find((t) => t.id === id);
        if (thread) {
          get().syncThreadToDatabase(thread);
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

          // Load messages for each thread (convert to store's expected format)
          const messages: Record<string, Message[]> = {};
          for (const thread of mergedThreads) {
            const threadData = await getThreadIPC(thread.id);
            if (threadData) {
              messages[thread.id] = (threadData.messages || []).map((m) => ({
                id: m.id,
                role: m.role,
                content: m.content,
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
              }));
            }
          }

          // Load projects (already converted to camelCase by getProjectGroupsIPC)
          const projects: ProjectGroup[] = (await getProjectGroupsIPC()).map((p) => ({
            ...p,
            isExpanded: true,
          }));

          set({
            threads: mergedThreads,
            messages,
            projects,
            lastSyncAt: now,
            isHydrated: true,
            ...(newChildParentIds.length > 0 ? {
              expandedThreads: new Set([...get().expandedThreads, ...newChildParentIds])
            } : {}),
          });
        } catch (error) {
          console.error('[Store] Failed to load from database:', error);
          // On error, keep existing data but mark as hydrated
          set({ isHydrated: true });
        }
      },

      forceSync: async () => {
        // Reset lastSyncAt to force immediate reload
        set({ lastSyncAt: 0 });
        await get().loadFromDatabase();
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

      syncMessageToDatabase: async (threadId, message) => {
        try {
          await addMessageIPC({
            id: message.id,
            sessionId: threadId,
            role: message.role,
            content: message.content,
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
          });
        } catch (error) {
          console.error('[Store] Failed to sync message to database:', error);
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
        lastSyncAt: state.lastSyncAt,
      }),
      onRehydrateStorage: () => (state) => {
        // Mark hydration complete and restore collapsedProjects Set
        if (state) {
          (state as ConversationState).isHydrated = true;
          if (Array.isArray((state as ConversationState).collapsedProjects)) {
            (state as ConversationState).collapsedProjects = new Set(
              (state as ConversationState).collapsedProjects as unknown as string[]
            );
          }
          if (Array.isArray((state as ConversationState).expandedThreads)) {
            (state as ConversationState).expandedThreads = new Set(
              (state as ConversationState).expandedThreads as unknown as string[]
            );
          }
          // Ensure lastSyncAt is initialized
          if (!(state as ConversationState).lastSyncAt) {
            (state as ConversationState).lastSyncAt = 0;
          }
        }
      },
    }
  )
);

// Handle sync event from other tabs/windows
function handleSyncEvent(source: string) {
  console.log(`[Sync] Received sync event from ${source}`);
  const store = useConversationStore.getState();
  // Only sync if we're not currently in an active chat
  // to avoid disrupting the user's current work
  if (store.activeThreadId === null) {
    store.forceSync();
  } else {
    // Mark as stale so next loadFromDatabase will refresh
    useConversationStore.setState({ lastSyncAt: 0 });
  }
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
