import type {
  WikiNode,
  WikiIndexEntry,
  WikiLogEntry,
  WikiRuntimeActivity,
  WikiRuntimeState,
  WikiRuntimeStatus,
} from '@/types/memory';

type WikiApiLike = {
  listAllNodes: () => Promise<unknown[]>;
  getNode: (nodePath: string) => Promise<unknown | null>;
  updateNode: (node: unknown) => Promise<boolean>;
  deleteNode: (nodePath: string) => Promise<boolean>;
  searchNodes: (query: string) => Promise<unknown[]>;
  readIndex: () => Promise<unknown[]>;
  readLog: () => Promise<unknown[]>;
  listInboxFiles: () => Promise<string[]>;
  readInboxFile: (filename: string) => Promise<string | null>;
  deleteInboxFile: (filename: string) => Promise<boolean>;
  getRootPath: () => Promise<string>;
  getRuntimeStatus?: () => Promise<unknown>;
  onActivity?: (callback: (data: unknown) => void) => (() => void) | void;
};

type WindowWithWikiApi = Window & {
  api?: {
    wiki?: WikiApiLike;
  };
  electronAPI?: {
    wiki?: WikiApiLike;
  };
};

function getWikiApi(): WikiApiLike | null {
  const win = window as WindowWithWikiApi;
  return win.api?.wiki ?? win.electronAPI?.wiki ?? null;
}

function requireWikiApi(): WikiApiLike {
  const api = getWikiApi();
  if (!api) {
    throw new Error('Wiki API is not available in the renderer.');
  }
  return api;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function coerceRuntimeState(value: unknown): WikiRuntimeState {
  if (typeof value !== 'string') return 'idle';

  switch (value.toLowerCase()) {
    case 'queued':
    case 'queue':
    case 'pending':
      return 'queued';
    case 'processing':
    case 'running':
    case 'working':
    case 'busy':
    case 'classifying':
    case 'extracting':
    case 'merging':
    case 'writing':
      return 'processing';
    case 'completed':
    case 'done':
      return 'idle';
    case 'error':
    case 'failed':
      return 'error';
    default:
      return 'idle';
  }
}

function coerceTimestamp(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function coerceSummary(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function coerceErrorMessage(value: unknown): string | null {
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (value instanceof Error && value.message.trim()) return value.message.trim();
  return null;
}

function normalizeRuntimeStatus(raw: unknown): WikiRuntimeStatus {
  const base: WikiRuntimeStatus = {
    state: 'idle',
    summary: null,
    updatedAt: null,
    isAvailable: false,
    supportsRuntimeStatus: false,
    supportsActivitySubscription: false,
    supportsNodeAgentChat: false,
    errorMessage: null,
  };

  const api = getWikiApi();
  base.supportsRuntimeStatus = typeof api?.getRuntimeStatus === 'function';
  base.supportsActivitySubscription = typeof api?.onActivity === 'function';

  if (!base.supportsRuntimeStatus) {
    return base;
  }

  if (!isRecord(raw)) {
    return { ...base, isAvailable: true };
  }

  return {
    ...base,
    state: coerceRuntimeState(raw.state ?? raw.status ?? raw.phase),
    summary: coerceSummary(
      raw.summary ?? raw.lastActivitySummary ?? raw.activitySummary ?? raw.message
    ),
    updatedAt: coerceTimestamp(raw.updatedAt ?? raw.lastActivityAt ?? raw.timestamp),
    isAvailable:
      typeof raw.isAvailable === 'boolean'
        ? raw.isAvailable
        : typeof raw.available === 'boolean'
          ? raw.available
          : true,
    errorMessage: coerceErrorMessage(raw.errorMessage ?? raw.error),
  };
}

function normalizeRuntimeActivity(raw: unknown): WikiRuntimeActivity {
  if (!isRecord(raw)) {
    return {
      summary: null,
      timestamp: null,
    };
  }

  return {
    sessionId: typeof raw.sessionId === 'string' ? raw.sessionId : undefined,
    turnId: typeof raw.turnId === 'string' ? raw.turnId : undefined,
    phase: typeof raw.phase === 'string' ? raw.phase : undefined,
    state: raw.state || raw.status || raw.phase ? coerceRuntimeState(raw.state ?? raw.status ?? raw.phase) : undefined,
    summary: coerceSummary(
      raw.summary ?? raw.lastActivitySummary ?? raw.activitySummary ?? raw.message
    ),
    timestamp: coerceTimestamp(raw.updatedAt ?? raw.lastActivityAt ?? raw.timestamp),
    errorMessage: coerceErrorMessage(raw.errorMessage ?? raw.error),
  };
}

export async function listAllNodesIPC(): Promise<WikiIndexEntry[]> {
  return (await requireWikiApi().listAllNodes()) as WikiIndexEntry[];
}

export async function getNodeIPC(nodePath: string): Promise<WikiNode | null> {
  return (await requireWikiApi().getNode(nodePath)) as WikiNode | null;
}

export async function updateNodeIPC(node: WikiNode): Promise<boolean> {
  return requireWikiApi().updateNode(node);
}

export async function deleteNodeIPC(nodePath: string): Promise<boolean> {
  return requireWikiApi().deleteNode(nodePath);
}

export async function searchNodesIPC(query: string): Promise<WikiIndexEntry[]> {
  return (await requireWikiApi().searchNodes(query)) as WikiIndexEntry[];
}

export async function readIndexIPC(): Promise<WikiIndexEntry[]> {
  return (await requireWikiApi().readIndex()) as WikiIndexEntry[];
}

export async function readLogIPC(): Promise<WikiLogEntry[]> {
  return (await requireWikiApi().readLog()) as WikiLogEntry[];
}

export async function listInboxFilesIPC(): Promise<string[]> {
  return requireWikiApi().listInboxFiles();
}

export async function readInboxFileIPC(filename: string): Promise<string | null> {
  return requireWikiApi().readInboxFile(filename);
}

export async function deleteInboxFileIPC(filename: string): Promise<boolean> {
  return requireWikiApi().deleteInboxFile(filename);
}

export async function getWikiRootPathIPC(): Promise<string> {
  return requireWikiApi().getRootPath();
}

export async function getWikiRuntimeStatusIPC(): Promise<WikiRuntimeStatus> {
  const api = getWikiApi();
  if (!api?.getRuntimeStatus) {
    return normalizeRuntimeStatus(null);
  }

  try {
    const raw = await api.getRuntimeStatus();
    return normalizeRuntimeStatus(raw);
  } catch (error) {
    return {
      ...normalizeRuntimeStatus({ state: 'error' }),
      state: 'error',
      isAvailable: false,
      updatedAt: Date.now(),
      errorMessage: coerceErrorMessage(error) ?? 'Failed to load wiki runtime status.',
    };
  }
}

export function subscribeWikiActivityIPC(
  callback: (activity: WikiRuntimeActivity) => void
): () => void {
  const api = getWikiApi();
  if (!api?.onActivity) {
    return () => {};
  }

  const unsubscribe = api.onActivity((data) => {
    callback(normalizeRuntimeActivity(data));
  });

  return typeof unsubscribe === 'function' ? unsubscribe : () => {};
}
