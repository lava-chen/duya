import { create } from 'zustand';
import type {
  WikiNode,
  WikiIndexEntry,
  WikiLogEntry,
  MemoryViewTab,
  WikiRuntimeActivity,
  WikiRuntimeStatus,
} from '@/types/memory';
import {
  listAllNodesIPC,
  getNodeIPC,
  searchNodesIPC,
  readLogIPC,
  listInboxFilesIPC,
  readInboxFileIPC,
  deleteInboxFileIPC,
  getWikiRuntimeStatusIPC,
} from '@/lib/memory-ipc';

interface InboxItem {
  filename: string;
  content: string | null;
  loading: boolean;
}

interface MemoryState {
  viewTab: MemoryViewTab;
  nodes: WikiIndexEntry[];
  selectedNode: WikiNode | null;
  selectedNodePath: string | null;
  logEntries: WikiLogEntry[];
  inboxFiles: string[];
  inboxItems: InboxItem[];
  searchQuery: string;
  typeFilter: string | null;
  isLoadingNodes: boolean;
  isLoadingDetail: boolean;
  detailError: string | null;
  runtimeStatus: WikiRuntimeStatus;
  isLoadingRuntimeStatus: boolean;
  runtimeStatusError: string | null;

  setViewTab: (tab: MemoryViewTab) => void;
  setSearchQuery: (query: string) => void;
  setTypeFilter: (type: string | null) => void;
  loadNodes: () => Promise<void>;
  loadNodeDetail: (nodePath: string) => Promise<void>;
  selectNode: (nodePath: string | null) => void;
  searchNodes: (query: string) => Promise<void>;
  loadRuntimeStatus: () => Promise<void>;
  applyRuntimeActivity: (activity: WikiRuntimeActivity) => void;
  loadActivityLog: () => Promise<void>;
  loadInboxFiles: () => Promise<void>;
  loadInboxItem: (filename: string) => Promise<void>;
  removeInboxItem: (filename: string) => Promise<void>;
}

export const useMemoryStore = create<MemoryState>((set, get) => ({
  viewTab: 'graph',
  nodes: [],
  selectedNode: null,
  selectedNodePath: null,
  logEntries: [],
  inboxFiles: [],
  inboxItems: [],
  searchQuery: '',
  typeFilter: null,
  isLoadingNodes: false,
  isLoadingDetail: false,
  detailError: null,
  runtimeStatus: {
    state: 'idle',
    summary: null,
    updatedAt: null,
    isAvailable: false,
    supportsRuntimeStatus: false,
    supportsActivitySubscription: false,
    supportsNodeAgentChat: false,
    errorMessage: null,
  },
  isLoadingRuntimeStatus: false,
  runtimeStatusError: null,

  setViewTab: (tab) => set({ viewTab: tab }),

  setSearchQuery: (query) => set({ searchQuery: query }),

  setTypeFilter: (type) => set({ typeFilter: type }),

  loadNodes: async () => {
    set({ isLoadingNodes: true });
    try {
      const nodes = await listAllNodesIPC();
      set({ nodes, isLoadingNodes: false });
    } catch {
      set({ isLoadingNodes: false });
    }
  },

  loadNodeDetail: async (nodePath: string) => {
    set({
      isLoadingDetail: true,
      selectedNodePath: nodePath,
      detailError: null,
    });
    try {
      const node = await getNodeIPC(nodePath);
      set({
        selectedNode: node,
        isLoadingDetail: false,
        detailError: node ? null : 'This node is no longer available.',
      });
    } catch (error) {
      set({
        selectedNode: null,
        isLoadingDetail: false,
        detailError:
          error instanceof Error ? error.message : 'Failed to load the selected node.',
      });
    }
  },

  selectNode: (nodePath) => {
    if (nodePath) {
      get().loadNodeDetail(nodePath);
    } else {
      set({ selectedNode: null, selectedNodePath: null, detailError: null });
    }
  },

  searchNodes: async (query: string) => {
    if (!query.trim()) {
      get().loadNodes();
      return;
    }
    set({ isLoadingNodes: true });
    try {
      const nodes = await searchNodesIPC(query);
      set({ nodes, isLoadingNodes: false });
    } catch {
      set({ isLoadingNodes: false });
    }
  },

  loadRuntimeStatus: async () => {
    set({ isLoadingRuntimeStatus: true, runtimeStatusError: null });
    const runtimeStatus = await getWikiRuntimeStatusIPC();
    set({
      runtimeStatus,
      isLoadingRuntimeStatus: false,
      runtimeStatusError: runtimeStatus.errorMessage,
    });
  },

  applyRuntimeActivity: (activity) => {
    set((state) => {
      const nextState = activity.state ?? state.runtimeStatus.state;
      const nextSummary =
        activity.summary !== null ? activity.summary : state.runtimeStatus.summary;
      const nextTimestamp = activity.timestamp ?? Date.now();
      const nextError =
        activity.errorMessage ??
        (nextState === 'error' ? state.runtimeStatus.errorMessage : null);

      return {
        runtimeStatus: {
          ...state.runtimeStatus,
          state: nextState,
          summary: nextSummary,
          updatedAt: nextTimestamp,
          isAvailable: true,
          errorMessage: nextError,
        },
        runtimeStatusError: nextError,
      };
    });
  },

  loadActivityLog: async () => {
    try {
      const entries = await readLogIPC();
      set({ logEntries: entries });
    } catch {
      // ignore
    }
  },

  loadInboxFiles: async () => {
    try {
      const files = await listInboxFilesIPC();
      set({ inboxFiles: files, inboxItems: [] });
    } catch {
      // ignore
    }
  },

  loadInboxItem: async (filename: string) => {
    const existing = get().inboxItems.find((i) => i.filename === filename);
    if (existing?.content !== null) return;

    set((state) => ({
      inboxItems: [
        ...state.inboxItems.filter((i) => i.filename !== filename),
        { filename, content: null, loading: true },
      ],
    }));

    try {
      const content = await readInboxFileIPC(filename);
      set((state) => ({
        inboxItems: state.inboxItems.map((i) =>
          i.filename === filename ? { ...i, content, loading: false } : i
        ),
      }));
    } catch {
      set((state) => ({
        inboxItems: state.inboxItems.map((i) =>
          i.filename === filename ? { ...i, loading: false } : i
        ),
      }));
    }
  },

  removeInboxItem: async (filename: string) => {
    await deleteInboxFileIPC(filename);
    set((state) => ({
      inboxFiles: state.inboxFiles.filter((f) => f !== filename),
      inboxItems: state.inboxItems.filter((i) => i.filename !== filename),
    }));
  },
}));
