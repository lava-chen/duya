/**
 * db-handlers.test.ts — Per-handler forwarding correctness for the core
 * DB IPC channels (plan 328 Phase 2.4).
 *
 * Since commit 8f7f5032 ("feat(host): run CLI and Desktop through the Host
 * worker") the Desktop handlers no longer talk to the core stores
 * directly: session, message, lock, task and permission CRUD all cross the
 * Host boundary (`../../cli/desktop-host-api`), and the IPC row shape is
 * produced by the adapters in `../core-db-adapters`.
 *
 * Coverage:
 *   - session:* / message:* / lock:* / task:* / permission:* / search:*
 *     channels forward to the right Host API method with correctly mapped
 *     args and return the adapter-shaped row.
 *   - The legacy snake_case IPC row survives the migration: the handler
 *     reads the Host session through the LOCAL adapter and maps it with
 *     `coreSessionToIpcRow`.
 *   - db:session:delete is a soft delete on the Host side (the Host keeps
 *     the row for recovery).
 *   - db:session:archive / db:session:unarchive forward to the Host archive
 *     operations; the mock delegates to the REAL Host implementation over
 *     the mocked core stores, so the archive contract (lock preflight,
 *     subtree walk, file moves, two-phase commit) stays covered here.
 *   - Errors from Host methods propagate through the handler.
 *
 * Pattern mirrors logger-handlers.test.ts / git-handlers.test.ts: all
 * mock state lives in vi.hoisted() so the vi.mock() factories (also
 * hoisted) and test bodies share one singleton.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CoreSession } from '@duya/data/session-store';
import { createHostSessionApi } from '@duya/host/session-api';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// All mock state lives in vi.hoisted so the vi.mock factory closures
// (also hoisted) and the test bodies see the same singleton.
const mocks = vi.hoisted(() => {
  // Session extension-bound columns, mirroring the real adapter.
  const SESSION_EXTENSION_KEYS = [
    'system_prompt',
    'conductor_mode_enabled',
    'conductor_canvas_id',
    'context_summary',
    'context_summary_updated_at',
    'plan_mode_enabled',
    'goal_mode_enabled',
    'source',
  ] as const;

  const captured = {
    handle: new Map<
      string,
      (event: unknown, ...args: unknown[]) => unknown | Promise<unknown>
    >(),
  };

  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    time: vi.fn(() => () => undefined),
    timeAsync: vi.fn(),
  };

  // ─── Mock stores (returned by getCoreStores()) ───
  // Each store method is a vi.fn with a default implementation so tests
  // can override return values per-call via mockReturnValueOnce without
  // losing the defaults for un-overridden calls.
  const sessionRows = new Map<string, CoreSession>();
  const makeSession = (input: Record<string, unknown>): CoreSession => ({
    id: String(input.id),
    title: 'Mock',
    workingDirectory: '',
    projectName: '',
    status: 'active',
    model: '',
    providerId: '',
    mode: 'code',
    permissionMode: (input.permissionMode as string) ?? 'default',
    agentProfileId: null,
    parentSessionId: null,
    agentType: '',
    agentName: '',
    draft: null,
    extensions: {},
    rolloutPath: null,
    archivedAt: null,
    archivedPath: null,
    recencyAt: 1000,
    lastTurnStartedAt: null,
    createdAt: 1000,
    updatedAt: 1000,
  });
  const sessions = {
    create: vi.fn((input: Record<string, unknown>) => {
      const session = makeSession(input);
      sessionRows.set(session.id, session);
      return session;
    }),
    get: vi.fn((sessionId: string) => sessionRows.get(sessionId)),
    update: vi.fn(),
    delete: vi.fn(),
    list: vi.fn(() => []),
    saveDraft: vi.fn(),
    getDraft: vi.fn(() => null),
    setExtension: vi.fn(),
    getExtension: vi.fn(() => undefined),
    getRolloutPath: vi.fn(() => null),
    setRolloutPath: vi.fn(),
    search: vi.fn(() => []),
    listSummaries: vi.fn(() => []),
    getSummary: vi.fn(() => undefined),
  };

  const messageLog = {
    appendBatch: vi.fn(),
    timeline: vi.fn(() => []),
    getLastSequence: vi.fn(() => null),
    listBySession: vi.fn(() => []),
    getCount: vi.fn(() => 0),
    getCountByKind: vi.fn(() => 0),
    deleteBySession: vi.fn(),
    searchText: vi.fn(() => []),
    rewriteSession: vi.fn(),
    // Plan 582 (G1/G2): whole-session file enumeration + cache invalidation.
    // Default [] keeps the "no rollout file" metadata-only path reachable;
    // tests that exercise the file moves override it.
    collectSessionRolloutFiles: vi.fn(() => [] as string[]),
    invalidateRolloutPathCache: vi.fn(),
  };

  const tasks = {
    create: vi.fn((input: Record<string, unknown>) => ({
      id: input.id,
      sessionId: input.sessionId,
      subject: input.subject,
      description: input.description,
      status: 'pending',
      activeForm: input.activeForm ?? null,
      owner: input.owner ?? null,
      blocks: [],
      blockedBy: [],
      metadata: {},
      createdAt: 1000,
      updatedAt: 1000,
    })),
    get: vi.fn(() => undefined),
    getBySession: vi.fn(() => []),
    update: vi.fn(),
    delete: vi.fn(() => true),
    deleteBySession: vi.fn(),
    claim: vi.fn(() => ({ success: false })),
    block: vi.fn(),
    unassignTeammate: vi.fn(),
    getByOwner: vi.fn(() => []),
  };

  const permissions = {
    create: vi.fn((input: Record<string, unknown>) => ({
      id: input.id,
      sessionId: input.sessionId ?? null,
      toolName: input.toolName,
      toolInput: input.toolInput ?? null,
      status: 'pending',
      decision: null,
      message: null,
      updatedPermissions: null,
      updatedInput: null,
      createdAt: 1000,
      resolvedAt: null,
    })),
    get: vi.fn(() => undefined),
    resolve: vi.fn(),
  };

  const locks = {
    acquire: vi.fn(() => true),
    renew: vi.fn(() => true),
    release: vi.fn(() => true),
    isLocked: vi.fn(() => false),
    // Plan 582 (G2): who holds the lock, for the archive refusal payload.
    lockOrigin: vi.fn(() => null as string | null),
  };

  // Plan 582 (G2): archive walks the spawn subtree, so the handler needs a
  // real tree. Default [] means "no children"; subtree tests override.
  const spawnEdges = {
    getTree: vi.fn(() => [] as Array<{ childSessionId: string }>),
  };

  const coreDb = { db: {} };
  const resolveRolloutRoot = vi.fn(() => '/tmp/rollout-root');
  const agentProfileRows = new Map<string, Record<string, unknown>>();
  const agentProfileApi = {
    listAgentProfiles: vi.fn(async () => [...agentProfileRows.values()]),
    getAgentProfile: vi.fn(async (id: string) => agentProfileRows.get(id) ?? null),
    createAgentProfile: vi.fn(async (input: Record<string, unknown>) => {
      const id = (input.id as string | undefined) || 'generated-profile';
      const now = Date.now();
      const row: Record<string, unknown> = {
        id,
        name: input.name || 'New Agent',
        description: input.description ?? null,
        allowed_tools: input.allowed_tools ? JSON.stringify(input.allowed_tools) : null,
        disallowed_tools: input.disallowed_tools ? JSON.stringify(input.disallowed_tools) : null,
        prompt_system: input.prompt_system ?? null,
        prompt_profile: input.prompt_profile ? JSON.stringify(input.prompt_profile) : null,
        default_model: input.default_model ?? null,
        profile_kind: input.profile_kind ?? 'main',
        user_visible: input.user_visible !== undefined ? (input.user_visible ? 1 : 0) : 1,
        is_preset: input.is_preset !== undefined ? (input.is_preset ? 1 : 0) : 0,
        is_enabled: input.is_enabled !== undefined ? (input.is_enabled ? 1 : 0) : 1,
        created_at: now,
        updated_at: now,
      };
      agentProfileRows.set(id, row);
      return row;
    }),
    updateAgentProfile: vi.fn(async (id: string, input: Record<string, unknown>) => {
      const row = { ...(agentProfileRows.get(id) ?? {}), updated_at: Date.now() };
      for (const key of [
        'name', 'description', 'allowed_tools', 'disallowed_tools', 'prompt_system',
        'prompt_profile', 'default_model', 'profile_kind', 'is_enabled',
      ]) {
        if (input[key] === undefined) continue;
        const value = input[key];
        row[key] = ['allowed_tools', 'disallowed_tools', 'prompt_profile'].includes(key)
          ? (value ? JSON.stringify(value) : null)
          : key === 'is_enabled'
            ? (value ? 1 : 0)
            : key === 'profile_kind'
              ? (value ?? 'main')
              : key === 'description' || key === 'prompt_system' || key === 'default_model'
                ? (value ?? null)
                : value;
      }
      agentProfileRows.set(id, row);
      return row;
    }),
    deleteAgentProfile: vi.fn(async (id: string) => agentProfileRows.delete(id)),
  };

  const mailbox = {
    enqueue: vi.fn(),
    get: vi.fn(() => undefined),
    edit: vi.fn(),
    guide: vi.fn(),
    promoteQueued: vi.fn(),
    cancel: vi.fn(),
    list: vi.fn(() => []),
    listForSession: vi.fn(() => []),
  };

  const stores = {
    coreDb,
    messageLog,
    sessions,
    mailbox,
    tasks,
    permissions,
    locks,
    spawnEdges,
    resolveRolloutRoot,
  };

  // ─── Mock adapters (core-db-adapters) ───
  // Each adapter returns a recognizable tagged object so tests can assert
  // that the handler forwards the adapter's output (not a re-implementation
  // of the mapping logic). The tagged shape also makes return-value
  // assertions resilient to unrelated field changes in the real adapters.
  // The field mapping mirrors the real adapter, so a forwarded value can be
  // asserted field by field.
  const adapters = {
    ipcSessionToCoreCreate: vi.fn(
      (data: Record<string, unknown>, permissionMode: string) => ({
        __tag: 'coreCreate',
        id: data.id,
        title: data.title,
        workingDirectory: data.working_directory,
        projectName: data.project_name,
        status: data.status,
        model: data.model,
        providerId: data.provider_id,
        mode: data.mode,
        permissionMode,
        agentProfileId: (data.agent_profile_id as string | null | undefined) ?? null,
        parentSessionId:
          (data.parent_session_id as string | undefined) ??
          (data.parent_id as string | undefined) ??
          null,
        agentType: data.agent_type,
        agentName: data.agent_name,
        draft: (data.draft_message as string | null | undefined) ?? null,
        extensions: Object.fromEntries(
          SESSION_EXTENSION_KEYS
            .filter((key) => data[key] !== undefined)
            .map((key) => [key, data[key]]),
        ),
        createdAt: data.created_at,
        updatedAt: data.updated_at,
      }),
    ),
    ipcSessionToUpdate: vi.fn((data: Record<string, unknown>) => ({
      __tag: 'coreUpdate',
      ...(data.title !== undefined ? { title: data.title } : {}),
      ...(data.working_directory !== undefined ? { workingDirectory: data.working_directory } : {}),
      ...(data.project_name !== undefined ? { projectName: data.project_name } : {}),
      ...(data.status !== undefined ? { status: data.status } : {}),
      ...(data.model !== undefined ? { model: data.model } : {}),
      ...(data.provider_id !== undefined ? { providerId: data.provider_id } : {}),
      ...(data.mode !== undefined ? { mode: data.mode } : {}),
      ...(data.permission_profile !== undefined ? { permissionMode: data.permission_profile } : {}),
      ...(data.parent_id !== undefined ? { parentSessionId: data.parent_id } : {}),
      ...(data.agent_profile_id !== undefined ? { agentProfileId: data.agent_profile_id } : {}),
      ...(data.agent_type !== undefined ? { agentType: data.agent_type } : {}),
      ...(data.agent_name !== undefined ? { agentName: data.agent_name } : {}),
    })),
    coreSessionToIpcRow: vi.fn((session: Record<string, unknown>) => ({
      __tag: 'ipcRow',
      id: session.id,
      status: session.status,
      updated_at: session.updatedAt,
      generation: 0,
    })),
    ipcMessageToNewEvent: vi.fn(
      (sessionId: string, data: Record<string, unknown>) => ({
        __tag: 'newEvent',
        id: data.id,
        sessionId,
        turnId: null,
        payload: data,
        createdAt: 1000,
      }),
    ),
    storedEventToIpcMessage: vi.fn((event: Record<string, unknown>) => ({
      __tag: 'ipcMsg',
      id: event.id,
      session_id: event.sessionId,
      seq_index: event.seq,
    })),
    storedEventsToIpcMessages: vi.fn(
      (events: Array<Record<string, unknown>>) =>
        events.map((e) => ({
          __tag: 'ipcMsg',
          id: e.id,
          session_id: e.sessionId,
          seq_index: e.seq,
        })),
    ),
    serializeMessageContent: vi.fn((v: unknown) =>
      typeof v === 'string' ? v : JSON.stringify(v),
    ),
    serializeDisplayContent: vi.fn((v: unknown) => v ?? null),
    ipcTaskToCoreCreate: vi.fn((data: Record<string, unknown>) => ({
      __tag: 'taskCreate',
      id: data.id,
      sessionId: data.session_id,
      subject: data.subject,
      description: data.description,
      activeForm: data.active_form ?? null,
      owner: data.owner ?? null,
    })),
    ipcTaskToUpdate: vi.fn((data: Record<string, unknown>) => ({
      __tag: 'taskUpdate',
      ...data,
    })),
    coreTaskToIpcRow: vi.fn((task: Record<string, unknown>) => ({
      __tag: 'taskRow',
      id: task.id,
      session_id: task.sessionId,
      subject: task.subject,
    })),
    ipcPermissionToCoreCreate: vi.fn((data: Record<string, unknown>) => ({
      __tag: 'permCreate',
      id: data.id,
      sessionId: data.sessionId ?? null,
      toolName: data.toolName,
      toolInput: data.toolInput ?? null,
    })),
    ipcPermissionToResolve: vi.fn((extra?: Record<string, unknown>) => ({
      message: extra?.message,
      updatedPermissions: extra?.updatedPermissions,
      updatedInput: extra?.updatedInput,
    })),
    corePermissionToIpcRow: vi.fn((perm: Record<string, unknown>) => ({
      __tag: 'permRow',
      id: perm.id,
      status: perm.status,
    })),
    coreMailboxToIpcRow: vi.fn((item: Record<string, unknown>) => ({
      __tag: 'mailboxRow',
      id: item.id,
    })),
    // ── Adapters the Host-migrated handler calls ──
    hostMessageItemsToIpcMessages: vi.fn(
      (sessionId: string, items: Array<{ id: string; sequence: number }>) =>
        items.map((item) => ({
          __tag: 'ipcMsg',
          id: item.id,
          session_id: sessionId,
          seq_index: item.sequence,
        })),
    ),
    newEventToIpcMessage: vi.fn((event: Record<string, unknown>) => ({
      __tag: 'ipcMsg',
      id: event.id,
      session_id: event.sessionId,
      seq_index: event.seq,
    })),
    ipcTaskToHostCreate: vi.fn((data: Record<string, unknown>) => ({
      __tag: 'hostTaskCreate',
      id: data.id,
      subject: data.subject,
      description: data.description,
      status: data.status ?? 'pending',
      blocks: [],
      blockedBy: [],
      metadata: {},
    })),
    ipcTaskToHostUpdate: vi.fn((data: Record<string, unknown>) => ({
      __tag: 'hostTaskUpdate',
      ...data,
    })),
    hostTaskToIpcRow: vi.fn((task: Record<string, unknown>) => ({
      __tag: 'taskRow',
      id: task.id,
      session_id: task.sessionId,
      subject: task.subject,
    })),
    coreGoalToIpcRow: vi.fn((goal: Record<string, unknown>) => ({
      __tag: 'goalRow',
      id: goal.id,
      session_id: goal.sessionId,
      status: goal.status,
    })),
  };

  // ─── Host APIs (the boundary the handlers now use) ───
  // The Desktop handlers call the Host session/local-session/lock/task/
  // permission APIs instead of the core stores. These mocks are that
  // boundary: a small in-memory Host whose session rows are the source of
  // truth for the assertions.
  const hostSessions = new Map<string, Record<string, unknown>>();
  const hostTimeline = new Map<string, Array<Record<string, unknown>>>();
  const hostTasks = new Map<string, Record<string, unknown>>();
  const hostPermissions = new Map<string, Record<string, unknown>>();

  const makeHostSession = (input: Record<string, unknown>): Record<string, unknown> => ({
    id: String(input.id),
    title: (input.title as string | undefined) ?? 'Mock',
    projectName: (input.projectName as string | undefined) ?? '',
    status: (input.status as string | undefined) ?? 'active',
    model: (input.model as string | undefined) ?? '',
    providerId: (input.providerId as string | undefined) ?? '',
    mode: (input.mode as string | undefined) ?? 'code',
    permissionMode: (input.permissionMode as string | undefined) ?? 'default',
    agentProfileId: (input.agentProfileId as string | null | undefined) ?? null,
    parentSessionId: (input.parentSessionId as string | null | undefined) ?? null,
    agentType: (input.agentType as string | undefined) ?? '',
    agentName: (input.agentName as string | undefined) ?? '',
    draft: (input.draft as string | null | undefined) ?? null,
    extensions: (input.extensions as Record<string, unknown> | undefined) ?? {},
    workingDirectory: '',
    rolloutPath: null,
    archivedAt: null,
    archivedPath: null,
    recencyAt: 1000,
    lastTurnStartedAt: null,
    createdAt: 1000,
    updatedAt: 1000,
  });

  const hostSessionApi = {
    resolveSessionPermissionProfile: vi.fn(async () => 'default'),
    create: vi.fn(async (input: Record<string, unknown>) => {
      const session = makeHostSession(input);
      hostSessions.set(session.id as string, session);
      return session;
    }),
    get: vi.fn(async (sessionId: string) => hostSessions.get(sessionId) ?? null),
    list: vi.fn(async () => ({ sessions: [] as Array<Record<string, unknown>>, nextCursor: null })),
    searchSessions: vi.fn(async () => [] as Array<Record<string, unknown>>),
    searchMessages: vi.fn(async () => [] as Array<Record<string, unknown>>),
    update: vi.fn(
      async (sessionId: string, _expectedUpdatedAt: unknown, patch: Record<string, unknown>) => {
        const existing = hostSessions.get(sessionId);
        if (!existing) return { updated: false as const, reason: 'not_found' as const };
        const next = { ...existing, ...patch, updatedAt: 2000 };
        hostSessions.set(sessionId, next);
        return { updated: true as const, session: next };
      },
    ),
    delete: vi.fn(async (sessionId: string) => {
      if (!hostSessions.has(sessionId)) {
        return { deleted: false as const, reason: 'not_found' as const };
      }
      hostSessions.delete(sessionId);
      return { deleted: true as const };
    }),
    // archive/unarchive are wired to the REAL Host implementation in the
    // beforeEach below, so the archive contract stays covered.
    archive: vi.fn(),
    unarchive: vi.fn(),
    countTimeline: vi.fn(async () => 0),
    readMessages: vi.fn(async (sessionId: string) => ({
      sessionId,
      messages: [] as Array<Record<string, unknown>>,
      nextCursor: null,
    })),
    readProjectedTimeline: vi.fn(async (sessionId: string) => ({
      sessionId,
      entries: [] as Array<Record<string, unknown>>,
      nextCursor: null,
    })),
    readTimeline: vi.fn(async (sessionId: string) => ({
      sessionId,
      entries: [] as Array<Record<string, unknown>>,
      nextCursor: null,
    })),
    appendTimeline: vi.fn(
      async (sessionId: string, input: { entries: ReadonlyArray<Record<string, unknown>> }) => {
        const items = hostTimeline.get(sessionId) ?? [];
        hostTimeline.set(sessionId, [...items, ...input.entries]);
        return {
          sessionId,
          acceptedIds: input.entries.map((entry) => entry.id as string),
          writtenCount: input.entries.length,
          lastSequence: null,
          cursor: null,
        };
      },
    ),
    deleteTimeline: vi.fn(async () => 0),
    registerLocalDirectory: vi.fn(async (_directory: string) => ({
      state: 'bound' as const,
      workspaceId: 'workspace-test',
      rootId: 'root-test',
      relativePath: '',
    })),
  };

  const hostLocalSessionApi = {
    readLocalSession: vi.fn(async (sessionId: string) => hostSessions.get(sessionId) ?? null),
    listLocalSessions: vi.fn(async () => ({
      sessions: [] as Array<Record<string, unknown>>,
      nextCursor: null,
    })),
  };

  const hostLockApi = {
    acquireLock: vi.fn(async () => true),
    renewLock: vi.fn(async () => true),
    releaseLock: vi.fn(async () => true),
    isSessionLocked: vi.fn(async () => false),
    getSessionLockOrigin: vi.fn(async () => null as string | null),
  };

  const hostTaskApi = {
    createTask: vi.fn(async (sessionId: string, task: Record<string, unknown>) => {
      const row = { ...task, sessionId, createdAt: 1000, updatedAt: 1000 };
      hostTasks.set(row.id as string, row);
      return row;
    }),
    getTask: vi.fn(async (taskId: string) => hostTasks.get(taskId) ?? null),
    listTasks: vi.fn(async () => [] as Array<Record<string, unknown>>),
    listTasksByOwner: vi.fn(async () => [] as Array<Record<string, unknown>>),
    updateTask: vi.fn(async () => null),
    deleteTask: vi.fn(async () => true),
    deleteTasksBySession: vi.fn(async () => undefined),
    claimTask: vi.fn(async () => ({ success: false })),
    blockTasks: vi.fn(async () => true),
    getAgentStatuses: vi.fn(async () => []),
    unassignTeammateTasks: vi.fn(async () => ({ success: true })),
  };

  const hostPermissionApi = {
    createPermissionRequest: vi.fn(async (input: Record<string, unknown>) => {
      const row = {
        id: input.id as string,
        sessionId: (input.sessionId as string | null | undefined) ?? null,
        toolName: input.toolName as string,
        toolInput: (input.toolInput as Record<string, unknown> | null | undefined) ?? null,
        status: 'pending',
        decision: null,
        message: null,
        updatedPermissions: null,
        updatedInput: null,
        createdAt: 1000,
        resolvedAt: null,
      };
      hostPermissions.set(row.id, row);
      return row;
    }),
    getPermissionRequest: vi.fn(async (id: string) => hostPermissions.get(id) ?? null),
    listPendingPermissionRequests: vi.fn(async () => [] as Array<Record<string, unknown>>),
    resolvePermissionRequest: vi.fn(async (id: string) => hostPermissions.get(id) ?? null),
  };

  return {
    captured,
    logger,
    stores,
    sessionRows,
    adapters,
    resolveRolloutRoot,
    agentProfileRows,
    agentProfileApi,
    hostSessions,
    hostTimeline,
    hostTasks,
    hostPermissions,
    hostSessionApi,
    hostLocalSessionApi,
    hostLockApi,
    hostTaskApi,
    hostPermissionApi,
  };
});

// ─── Module mocks (paths relative to this test file) ───

vi.mock('electron', () => ({
  ipcMain: {
    handle: (
      c: string,
      fn: (event: unknown, ...args: unknown[]) => unknown | Promise<unknown>,
    ) => {
      mocks.captured.handle.set(c, fn);
    },
  },
  app: {
    isPackaged: false,
    getPath: vi.fn(() => '/tmp'),
    getAppPath: vi.fn(() => '/tmp'),
    getVersion: vi.fn(() => '0.0.0-test'),
    relaunch: vi.fn(),
    exit: vi.fn(),
  },
}));

vi.mock('../../db/core-connection', () => ({
  getCoreStores: () => mocks.stores,
  getCoreStoresOrNull: () => mocks.stores,
  _setCoreStoresForTesting: vi.fn(),
}));

vi.mock('../../db/index', () => ({
  initDatabaseFromBoot: vi.fn(),
  initDatabase: vi.fn(),
  getDatabase: vi.fn(() => null),
  getDatabasePath: vi.fn(() => '/tmp/test.db'),
  isSafeMode: vi.fn(() => false),
  getSafeModeReason: vi.fn(() => ''),
  getDatabaseStats: vi.fn(() => null),
  checkDatabaseSizeWarning: vi.fn(() => null),
}));

vi.mock('../../cli/desktop-host-api', async () => {
  const actual = await vi.importActual<typeof import('../../cli/desktop-host-api')>(
    '../../cli/desktop-host-api',
  );
  return {
    ...actual,
    getDesktopHostSessionApi: () => mocks.hostSessionApi,
    getDesktopHostLocalSessionApi: () => mocks.hostLocalSessionApi,
    getDesktopHostLockApi: () => mocks.hostLockApi,
    getDesktopHostTaskApi: () => mocks.hostTaskApi,
    getDesktopHostPermissionRequestApi: () => mocks.hostPermissionApi,
    getDesktopHostLocalAgentProfileApi: () => mocks.agentProfileApi,
  };
});

vi.mock('../../logging/logger', () => ({
  initLogger: vi.fn(),
  getLogger: () => mocks.logger,
  LogComponent: new Proxy({}, { get: (_t, p) => String(p) }),
}));

vi.mock('../../config/boot-config', () => ({
  resolveDatabasePath: vi.fn(() => ({
    dbPath: '/tmp/test.db',
    needsBootWrite: false,
    needsDbRename: false,
  })),
  resolveCoreDatabasePath: vi.fn(() => '/tmp/core.db'),
  // Plan 582 (G2): archive/unarchive move real files, so tests override this
  // with a temp directory instead of the placeholder.
  resolveRolloutRoot: mocks.resolveRolloutRoot,
  resolveAttachmentsRoot: vi.fn(() => '/tmp/attachments-root'),
  validateDatabasePath: vi.fn(() => ({ valid: true })),
  updateDatabasePath: vi.fn(() => true),
  readBootConfig: vi.fn(() => ({})),
}));

vi.mock('../core-db-adapters', () => mocks.adapters);

vi.mock('../../agents/process-pool/agent-process-pool', () => ({
  getAgentProcessPool: () => ({
    isRunning: () => false,
    send: () => false,
  }),
}));

vi.mock('../../automation/Scheduler', () => ({
  getAutomationScheduler: () => null,
}));

// Unified space search reads bots/routines from config.toml; empty them in
// tests so `db:search:query` is deterministic and hermetic.
vi.mock('../../config/agents', () => ({
  listConfigAgents: vi.fn(() => ({})),
  listBots: vi.fn(() => []),
  upsertConfigAgent: vi.fn(),
  deleteConfigAgent: vi.fn(),
  createConfigAgentUnique: vi.fn(),
  updateBotProfileIdentity: vi.fn(),
  setBotAvatarImage: vi.fn(),
  clearBotAvatarImage: vi.fn(),
  slugifyBotIdFromName: vi.fn(),
}));

vi.mock('../../automation/cron-file', () => ({
  CronFileStore: class {
    listCrons(): unknown[] {
      return [];
    }
  },
}));

vi.mock('../../messaging/port-manager', () => ({
  getChannelManager: () => null,
}));

vi.mock('../../messaging/mailbox-broadcaster', () => ({
  emitMailApplied: vi.fn(),
  emitMailCreated: vi.fn(),
  emitMailEdited: vi.fn(),
  emitMailCancelled: vi.fn(),
}));

vi.mock('../../gateway/config-events', () => ({
  emitGatewayConfigChanged: vi.fn(),
  isGatewayConfigKey: vi.fn(() => false),
}));

vi.mock('../../services/mcp-write-reload', () => ({
  notifyMcpConfigChanged: vi.fn(),
}));

vi.mock('../../services/mcp-toml-config', () => ({
  readUserMcpToml: vi.fn(() => ''),
  writeUserMcpToml: vi.fn(),
}));

vi.mock('../../db/queries/conductors', () => ({
  createCanvas: vi.fn(() => ({})),
  getMaxZIndex: vi.fn(() => 0),
}));

vi.mock('../../conductor/asset-service', () => ({
  uploadAsset: vi.fn(),
  uploadProjectAsset: vi.fn(),
}));

vi.mock('../../conductor/link-snapshot-service', () => ({
  captureWebsiteSnapshot: vi.fn(() => null),
}));

vi.mock('../../conductor/document-service', () => ({
  prepareCanvasDocument: vi.fn(),
  syncCanvasDocument: vi.fn(),
}));

// Import AFTER all vi.mock() calls so the module under test picks up
// the mocked dependencies.
import { registerDbHandlers } from '../db-handlers';
import { getDatabase } from '../../db/index';
import { formatArchiveDate } from '../../db/core/archive-paths';

// ─── Helper ───

/** Seed a Host session row so a handler can read it back through the Host. */
function seedHostSession(
  id: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const session = {
    id,
    title: 'Mock',
    projectName: '',
    status: 'active',
    model: '',
    providerId: '',
    mode: 'code',
    permissionMode: 'default',
    agentProfileId: null,
    parentSessionId: null,
    agentType: '',
    agentName: '',
    draft: null,
    extensions: {},
    workingDirectory: '',
    rolloutPath: null,
    archivedAt: null,
    archivedPath: null,
    recencyAt: 1000,
    lastTurnStartedAt: null,
    createdAt: 1000,
    updatedAt: 1000,
    ...overrides,
  };
  mocks.hostSessions.set(id, session);
  return session;
}

async function invokeHandler(
  channel: string,
  event: unknown = {},
  ...args: unknown[]
): Promise<unknown> {
  const handler = mocks.captured.handle.get(channel);
  if (!handler)
    throw new Error(`No handler registered for channel "${channel}"`);
  return await handler(event, ...args);
}

// ─── Tests ───

describe('db-handlers (core store thin forward)', () => {
  beforeEach(() => {
    // vi.resetAllMocks() clears the call history AND restores the default
    // implementation of every mock, so a stub installed by one test (a
    // store override, a queued return value) cannot leak into the next one.
    vi.resetAllMocks();
    mocks.captured.handle.clear();
    mocks.sessionRows.clear();
    mocks.agentProfileRows.clear();
    mocks.hostSessions.clear();
    mocks.hostTimeline.clear();
    mocks.hostTasks.clear();
    mocks.hostPermissions.clear();
    // The archive/unarchive semantics moved into the Host package with the
    // Desktop→Host migration, so the mock delegates to the REAL Host
    // implementation over the same mocked core stores. That keeps the
    // archive contract (lock preflight, subtree walk, file moves, two-phase
    // commit) covered here instead of being asserted against a stub.
    const hostArchiveApi = () =>
      createHostSessionApi({
        stores: mocks.stores as unknown as Parameters<
          typeof createHostSessionApi
        >[0]['stores'],
        rolloutRoot: mocks.resolveRolloutRoot(),
      });
    mocks.hostSessionApi.archive.mockImplementation((sessionId: string) =>
      hostArchiveApi().archive(sessionId),
    );
    mocks.hostSessionApi.unarchive.mockImplementation((sessionId: string) =>
      hostArchiveApi().unarchive(sessionId),
    );
    registerDbHandlers();
  });

  // ==================== Session Handlers ====================

  describe('db:session:create', () => {
    it('forwards to the Host session API and returns coreSessionToIpcRow', async () => {
      const data = {
        id: 's1',
        title: 'Test',
        permission_profile: 'plan',
        working_directory: '/tmp',
      };
      const result = await invokeHandler('db:session:create', {}, data);

      // Host resolves permission inheritance and the user default before the
      // single session write.
      expect(mocks.hostSessionApi.resolveSessionPermissionProfile).toHaveBeenCalledWith({
        explicit: 'plan',
        parentSessionId: null,
        trustedOverride: false,
      });
      // The resolved profile is what the adapter maps into the create input.
      expect(mocks.adapters.ipcSessionToCoreCreate).toHaveBeenCalledWith(
        data,
        'default',
      );
      // The requested folder is registered through Host; only the opaque
      // workspace reference is persisted.
      expect(mocks.hostSessionApi.registerLocalDirectory).toHaveBeenCalledWith('/tmp');
      expect(mocks.hostSessionApi.create).toHaveBeenCalledTimes(1);
      expect(mocks.hostSessionApi.create).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 's1',
          title: 'Test',
          permissionMode: 'default',
          workspaceId: 'workspace-test',
          workspaceRootId: 'root-test',
          workspaceRelativePath: '',
        }),
      );
      // The row is read back through the LOCAL Host adapter and mapped.
      expect(mocks.hostLocalSessionApi.readLocalSession).toHaveBeenCalledWith('s1', {
        includeAllSessions: true,
      });
      expect(mocks.adapters.coreSessionToIpcRow).toHaveBeenCalledTimes(1);
      expect(result).toMatchObject({ __tag: 'ipcRow', id: 's1' });
    });

    it('propagates errors from the Host session API', async () => {
      mocks.hostSessionApi.create.mockImplementationOnce(() => {
        throw new Error('db locked');
      });
      await expect(
        invokeHandler('db:session:create', {}, { id: 's1' }),
      ).rejects.toThrow('db locked');
    });
  });

  describe('db:session:get', () => {
    it('returns coreSessionToIpcRow when found', async () => {
      const session = seedHostSession('s1', { status: 'active', updatedAt: 1000 });
      const result = await invokeHandler('db:session:get', {}, 's1');

      expect(mocks.hostLocalSessionApi.readLocalSession).toHaveBeenCalledWith('s1', {
        includeAllSessions: true,
      });
      expect(mocks.adapters.coreSessionToIpcRow).toHaveBeenCalledWith(session);
      expect(result).toMatchObject({ __tag: 'ipcRow', id: 's1' });
    });

    it('returns undefined when not found', async () => {
      const result = await invokeHandler('db:session:get', {}, 'missing');
      expect(result).toBeUndefined();
      expect(mocks.adapters.coreSessionToIpcRow).not.toHaveBeenCalled();
    });
  });

  describe('db:session:update', () => {
    it('forwards patch via ipcSessionToUpdate and writes extension-bound keys', async () => {
      seedHostSession('s1');
      const data = { title: 'New', system_prompt: 'sys' };
      const result = await invokeHandler('db:session:update', {}, 's1', data);

      expect(mocks.adapters.ipcSessionToUpdate).toHaveBeenCalledWith(data);
      expect(mocks.hostSessionApi.update).toHaveBeenCalledTimes(1);
      const [idArg, expectedArg, patchArg] = mocks.hostSessionApi.update.mock
        .calls[0] as [string, undefined, Record<string, unknown>];
      expect(idArg).toBe('s1');
      expect(expectedArg).toBeUndefined();
      // system_prompt is an extension-bound field — it travels inside the
      // Host extension object, not as a top-level column.
      expect(patchArg).toMatchObject({
        title: 'New',
        extensions: { system_prompt: 'sys' },
      });
      expect(result).toMatchObject({ __tag: 'ipcRow', id: 's1' });
    });
  });

  describe('db:session:delete', () => {
    it('soft-deletes through the Host session API — never deletes the row locally', async () => {
      seedHostSession('s1');
      const result = await invokeHandler('db:session:delete', {}, 's1');

      expect(result).toBe(true);
      expect(mocks.hostSessionApi.delete).toHaveBeenCalledWith('s1');
      // The Host keeps the row for recovery; Desktop must not delete it.
      expect(mocks.stores.sessions.delete).not.toHaveBeenCalled();
    });

    it('returns false when session does not exist', async () => {
      const result = await invokeHandler('db:session:delete', {}, 'missing');
      expect(result).toBe(false);
      expect(mocks.hostSessionApi.delete).toHaveBeenCalledWith('missing');
      expect(mocks.stores.sessions.delete).not.toHaveBeenCalled();
    });
  });

  describe('db:session:list', () => {
    it('lists all sessions (cron sessions are ordinary now) and maps each row', async () => {
      const sessions = [
        seedHostSession('s1', { status: 'active', updatedAt: 1000 }),
        seedHostSession('s2', { status: 'active', updatedAt: 2000 }),
      ];
      mocks.hostLocalSessionApi.listLocalSessions.mockResolvedValueOnce({
        sessions,
        nextCursor: null,
      } as never);
      const result = (await invokeHandler('db:session:list', {})) as unknown[];

      expect(mocks.hostLocalSessionApi.listLocalSessions).toHaveBeenCalledWith({
        includeAllSessions: true,
        limit: 200,
      });
      expect(mocks.adapters.coreSessionToIpcRow).toHaveBeenCalledTimes(2);
      expect(result).toHaveLength(2);
      expect((result[0] as Record<string, unknown>).id).toBe('s1');
    });
  });

  // ==================== Message Handlers ====================

  describe('db:message:add', () => {
    it('appends a single NewEvent via the Host timeline and reads back the row', async () => {
      const data = {
        id: 'm1',
        session_id: 's1',
        role: 'user',
        content: 'hi',
      };
      // The read-back goes through Host too, so the append result is read
      // from the Host message projection.
      mocks.hostSessionApi.readMessages.mockResolvedValueOnce({
        sessionId: 's1',
        messages: [{ id: 'm1', sequence: 0, createdAt: 1000, turnId: null, entry: {} }],
        nextCursor: null,
      } as never);
      const result = await invokeHandler('db:message:add', {}, data);

      expect(mocks.adapters.ipcMessageToNewEvent).toHaveBeenCalledWith(
        's1',
        data,
      );
      // Decision 5: append-only (INSERT OR IGNORE) semantics — the payload
      // is appended to the Host timeline, never replaced.
      expect(mocks.hostSessionApi.appendTimeline).toHaveBeenCalledTimes(1);
      expect(mocks.hostSessionApi.appendTimeline).toHaveBeenCalledWith('s1', {
        entries: [data],
      });
      expect(mocks.hostSessionApi.readMessages).toHaveBeenCalledWith('s1', {
        includeSuperseded: true,
        limit: 200,
      });
      expect(mocks.adapters.hostMessageItemsToIpcMessages).toHaveBeenCalledTimes(1);
      expect(result).toMatchObject({ __tag: 'ipcMsg', id: 'm1' });
    });

    it('returns null when the stored event cannot be found after append', async () => {
      const result = await invokeHandler('db:message:add', {}, {
        id: 'm1',
        session_id: 's1',
        role: 'user',
        content: 'hi',
      });
      expect(result).toBeNull();
    });
  });

  describe('db:message:getBySession', () => {
    it('forwards to the Host message projection and maps via hostMessageItemsToIpcMessages', async () => {
      const items = [
        { id: 'm1', sequence: 0, createdAt: 1000, turnId: null, entry: {} },
        { id: 'm2', sequence: 1, createdAt: 1001, turnId: null, entry: {} },
      ];
      mocks.hostSessionApi.readMessages.mockResolvedValueOnce({
        sessionId: 's1',
        messages: items,
        nextCursor: null,
      } as never);
      const result = (await invokeHandler(
        'db:message:getBySession',
        {},
        's1',
      )) as unknown[];

      // 9477e278 ("keep superseded messages visible in chat UI history") made
      // the handler default `includeSuperseded` to true, so the options bag is
      // now always forwarded. Assert the full call shape rather than the
      // legacy single-argument form.
      expect(mocks.hostSessionApi.readMessages).toHaveBeenCalledWith('s1', {
        includeSuperseded: true,
        limit: 200,
      });
      expect(mocks.adapters.hostMessageItemsToIpcMessages).toHaveBeenCalledWith(
        's1',
        items,
      );
      expect(result).toHaveLength(2);
    });
  });

  describe('db:message:getCount', () => {
    it('returns the count from the Host timeline', async () => {
      mocks.hostSessionApi.countTimeline.mockResolvedValueOnce(42);
      const result = await invokeHandler('db:message:getCount', {}, 's1');
      expect(mocks.hostSessionApi.countTimeline).toHaveBeenCalledWith('s1');
      expect(result).toBe(42);
    });
  });

  describe('db:message:replace', () => {
    it('auto-creates a missing session and appends events via the Host timeline (decision 3)', async () => {
      // The Host session lookup returns null → auto-create path.
      const messages = [
        { id: 'm1', role: 'user', content: 'a' },
        { id: 'm2', role: 'assistant', content: 'b' },
      ];
      const result = await invokeHandler(
        'db:message:replace',
        {},
        's1',
        messages,
        1,
      );

      expect(mocks.hostSessionApi.get).toHaveBeenCalledWith('s1', {
        includeAllSessions: true,
      });
      expect(mocks.hostSessionApi.create).toHaveBeenCalledTimes(1);
      expect(mocks.hostSessionApi.create).toHaveBeenCalledWith(
        expect.objectContaining({ id: 's1' }),
      );
      // Decision 3: uses appendBatch, not a separate replace method.
      expect(mocks.hostSessionApi.appendTimeline).toHaveBeenCalledTimes(1);
      const [sessionIdArg, batchArg] = mocks.hostSessionApi.appendTimeline.mock
        .calls[0] as [string, { entries: unknown[] }];
      expect(sessionIdArg).toBe('s1');
      expect(batchArg.entries).toHaveLength(2);
      expect(mocks.adapters.ipcMessageToNewEvent).toHaveBeenCalledTimes(2);
      expect(result).toEqual({
        success: true,
        newGeneration: 0,
        messageCount: 2,
      });
    });

    it('skips session auto-create when the session already exists', async () => {
      seedHostSession('s1');
      await invokeHandler('db:message:replace', {}, 's1', [], 0);
      expect(mocks.hostSessionApi.create).not.toHaveBeenCalled();
    });
  });

  // ==================== Lock Handlers ====================

  describe('db:lock:acquire', () => {
    it('forwards (sessionId, lockId, owner, ttlSec) to the Host lock API', async () => {
      const result = await invokeHandler(
        'db:lock:acquire',
        {},
        's1',
        'l1',
        'owner-1',
      );
      // Default ttlSec is 300.
      expect(mocks.hostLockApi.acquireLock).toHaveBeenCalledWith({
        sessionId: 's1',
        lockId: 'l1',
        owner: 'owner-1',
        ttlSec: 300,
      });
      expect(result).toBe(true);
    });

    it('accepts an explicit ttlSec', async () => {
      await invokeHandler('db:lock:acquire', {}, 's1', 'l1', 'owner-1', 60);
      expect(mocks.hostLockApi.acquireLock).toHaveBeenCalledWith({
        sessionId: 's1',
        lockId: 'l1',
        owner: 'owner-1',
        ttlSec: 60,
      });
    });

    it('propagates errors from the Host lock API', async () => {
      mocks.hostLockApi.acquireLock.mockImplementationOnce(() => {
        throw new Error('lock table missing');
      });
      await expect(
        invokeHandler('db:lock:acquire', {}, 's1', 'l1', 'o'),
      ).rejects.toThrow('lock table missing');
    });
  });

  // ==================== Task Handlers ====================

  describe('db:task:create', () => {
    it('forwards to the Host task API via ipcTaskToHostCreate and returns hostTaskToIpcRow', async () => {
      const data = {
        id: 't1',
        session_id: 's1',
        subject: 'Do thing',
        description: 'Details',
        active_form: 'Doing thing',
        owner: 'agent-1',
      };
      const result = await invokeHandler('db:task:create', {}, data);

      expect(mocks.adapters.ipcTaskToHostCreate).toHaveBeenCalledWith(data);
      expect(mocks.hostTaskApi.createTask).toHaveBeenCalledTimes(1);
      const [sessionIdArg, createArg] = mocks.hostTaskApi.createTask.mock
        .calls[0] as [string, Record<string, unknown>];
      expect(sessionIdArg).toBe('s1');
      expect(createArg).toMatchObject({ __tag: 'hostTaskCreate', id: 't1' });
      expect(mocks.adapters.hostTaskToIpcRow).toHaveBeenCalledTimes(1);
      expect(result).toMatchObject({ __tag: 'taskRow', id: 't1' });
    });
  });

  // ==================== Permission Handlers ====================

  describe('db:permission:create', () => {
    it('forwards to the Host permission API via ipcPermissionToCoreCreate', async () => {
      const data = {
        id: 'p1',
        sessionId: 's1',
        toolName: 'Bash',
        toolInput: { cmd: 'ls' },
      };
      const result = await invokeHandler('db:permission:create', {}, data);

      expect(mocks.adapters.ipcPermissionToCoreCreate).toHaveBeenCalledWith(
        data,
      );
      expect(mocks.hostPermissionApi.createPermissionRequest).toHaveBeenCalledTimes(1);
      const createArg = mocks.hostPermissionApi.createPermissionRequest.mock
        .calls[0][0] as Record<string, unknown>;
      expect(createArg).toMatchObject({ __tag: 'permCreate', id: 'p1' });
      expect(mocks.adapters.corePermissionToIpcRow).toHaveBeenCalledTimes(1);
      expect(result).toMatchObject({ __tag: 'permRow', id: 'p1' });
    });
  });

  // ==================== Search Handlers ====================

  describe('db:search:query (unified space search)', () => {
    it('aggregates session + message + link hits with the nav/content budget', async () => {
      // 1 metadata (nav) hit on session s1.
      mocks.hostSessionApi.searchSessions.mockResolvedValueOnce([
        {
          session: {
            id: 's1',
            title: 'Alpha',
            agentName: '',
            projectName: 'proj',
            updatedAt: 3000,
          },
          snippet: '',
          messageId: null,
          sequence: null,
        },
      ] as never);
      // 1 content hit on session s2 — the Host resolves the session metadata
      // together with the matching message.
      mocks.hostSessionApi.searchMessages.mockResolvedValueOnce([
        {
          session: { id: 's2', title: 'Beta session' },
          messageId: 'm2',
          sequence: 3,
          snippet: 'see https://example.com/q now',
        },
      ] as never);

      const hits = (await invokeHandler(
        'db:search:query',
        {},
        'example.com',
      )) as Array<Record<string, unknown>>;

      // nav cap (8) drives the session search limit; content budget = 25 - 1 nav = 24 (+5 headroom).
      expect(mocks.hostSessionApi.searchSessions).toHaveBeenCalledWith('example.com', {
        limit: 8,
        includeContent: false,
      });
      expect(mocks.hostSessionApi.searchMessages).toHaveBeenCalledWith('example.com', 29);

      const sessionHit = hits.find((h) => h.kind === 'session');
      expect(sessionHit).toMatchObject({ kind: 'session', sessionId: 's1', title: 'Alpha', snippet: 'proj' });

      const messageHit = hits.find((h) => h.kind === 'message');
      expect(messageHit).toMatchObject({
        kind: 'message', sessionId: 's2', title: 'Beta session', messageId: 'm2', seq: 3,
      });

      // Link hit rides the matched message text.
      const linkHit = hits.find((h) => h.kind === 'link');
      expect(linkHit).toMatchObject({
        kind: 'link', sessionId: 's2', title: 'https://example.com/q', messageId: 'm2', seq: 3,
      });
    });

    it('returns an empty list for a blank query', async () => {
      const result = await invokeHandler('db:search:query', {}, '   ');
      expect(result).toEqual([]);
    });
  });

  describe('db:search:sessions', () => {
    it('combines the Host session search (metadata) with its content hits — decision 7', async () => {
      seedHostSession('s-content', { updatedAt: 2000 });
      seedHostSession('s-meta', { updatedAt: 1000 });
      // The Host owns both the metadata and the content hits, and the order
      // it returns (recency first) is the order the handler must keep.
      mocks.hostSessionApi.searchSessions.mockResolvedValueOnce([
        {
          session: { id: 's-content', title: 'Content', updatedAt: 2000 },
          snippet: 'hit',
          messageId: 'm1',
          sequence: 0,
        },
        {
          session: { id: 's-meta', title: 'Meta', updatedAt: 1000 },
          snippet: '',
          messageId: null,
          sequence: null,
        },
      ] as never);

      const result = (await invokeHandler(
        'db:search:sessions',
        {},
        'query',
      )) as Array<Record<string, unknown>>;

      expect(mocks.hostSessionApi.searchSessions).toHaveBeenCalledWith('query', {
        limit: 10,
      });
      // Each hit is re-read through the LOCAL Host projection so the row
      // keeps the legacy IPC shape.
      expect(mocks.hostLocalSessionApi.readLocalSession).toHaveBeenCalledWith('s-content', {
        includeAllSessions: true,
      });
      expect(mocks.hostLocalSessionApi.readLocalSession).toHaveBeenCalledWith('s-meta', {
        includeAllSessions: true,
      });
      // Both sources contributed one row, in the Host's order.
      expect(result).toHaveLength(2);
      expect(result[0].id).toBe('s-content');
      expect(result[0].snippet).toBe('hit');
      expect(result[1].id).toBe('s-meta');
      expect(result[1].snippet).toBe('');
    });

    it('skips hits whose session the local Host projection no longer returns', async () => {
      mocks.hostSessionApi.searchSessions.mockResolvedValueOnce([
        {
          session: { id: 's-del', title: 'Deleted', updatedAt: 2000 },
          snippet: 'hit',
          messageId: 'm1',
          sequence: 0,
        },
      ] as never);
      mocks.hostLocalSessionApi.readLocalSession.mockResolvedValueOnce(null);

      const result = (await invokeHandler(
        'db:search:sessions',
        {},
        'query',
      )) as unknown[];
      expect(result).toEqual([]);
    });
  });

  // ==================== Agent Profile Handlers ====================

  describe('db:agentProfile (prompt_profile persistence, Plan 420)', () => {
    it('persists prompt_profile through create and round-trips it on get', async () => {
      const created = (await invokeHandler('db:agentProfile:create', {}, {
        id: 'my-agent',
        name: 'My Agent',
        prompt_profile: { disableSections: ['memory'], enableSections: ['rules'] },
      })) as Record<string, unknown>;
      expect(created.prompt_profile).toBe(
        JSON.stringify({ disableSections: ['memory'], enableSections: ['rules'] }),
      );

      const fetched = (await invokeHandler('db:agentProfile:get', {}, 'my-agent')) as Record<string, unknown>;
      expect(fetched.prompt_profile).toBe(
        JSON.stringify({ disableSections: ['memory'], enableSections: ['rules'] }),
      );
    });

    it('updates prompt_profile via fieldMap and persists the new value', async () => {
      await invokeHandler('db:agentProfile:create', {}, {
        id: 'my-agent',
        name: 'My Agent',
        prompt_profile: { disableSections: ['memory'] },
      });

      const updated = (await invokeHandler('db:agentProfile:update', {}, 'my-agent', {
        prompt_profile: { disableSections: ['memory', 'skills'] },
      })) as Record<string, unknown>;
      expect(updated.prompt_profile).toBe(
        JSON.stringify({ disableSections: ['memory', 'skills'] }),
      );
    });

    it('stores null prompt_profile when absent (backward compatible)', async () => {
      const created = (await invokeHandler('db:agentProfile:create', {}, {
        id: 'plain-agent',
        name: 'Plain',
      })) as Record<string, unknown>;
      expect(created.prompt_profile).toBeNull();
    });
  });

  // ==================== Plan 583 / ISS-31: agent profile payload contract ====================
  // The handlers used to take `Record<string, unknown>` and coerce each value
  // with a bare `as` cast, so a type-confused payload reached the row verbatim.
  describe('db:agentProfile payload contract (ISS-31)', () => {
    it('refuses an object where a string column belongs', async () => {
      await expect(
        invokeHandler('db:agentProfile:update', {}, 'my-agent', { name: { evil: true } }),
      ).rejects.toThrow(/Invalid payload for db:agentProfile:update/);
    });

    it('refuses a scalar where a tool-pattern array belongs', async () => {
      await expect(
        invokeHandler('db:agentProfile:update', {}, 'my-agent', { allowed_tools: 'file:*' }),
      ).rejects.toThrow(/Invalid payload/);
    });

    it('refuses an oversized free-text column', async () => {
      await expect(
        invokeHandler('db:agentProfile:update', {}, 'my-agent', { description: 'a'.repeat(5001) }),
      ).rejects.toThrow(/Invalid payload/);
    });

    it('refuses a non-string profile id', async () => {
      await expect(
        invokeHandler('db:agentProfile:update', {}, 42, { name: 'ok' }),
      ).rejects.toThrow(/Invalid payload/);
    });

    it('refuses a type-confused payload on create', async () => {
      await expect(
        invokeHandler('db:agentProfile:create', {}, { id: 'a', name: 'A', profile_kind: 7 }),
      ).rejects.toThrow(/Invalid payload for db:agentProfile:create/);
    });

    it('still accepts a well-formed patch and strips unknown keys', async () => {
      await invokeHandler('db:agentProfile:create', {}, { id: 'my-agent', name: 'My Agent' });
      const updated = (await invokeHandler('db:agentProfile:update', {}, 'my-agent', {
        description: 'hello',
        bogus: 'ignored',
      })) as Record<string, unknown>;
      expect(updated.description).toBe('hello');
      expect(updated.bogus).toBeUndefined();
    });
  });

  // ==================== plan 413 db:relocateDatabase path-safety ====================
  // The DB holds all chats + credentials, so the relocate destination
  // must stay inside the user home directory. Only the rejection paths
  // are exercised here (no real file is ever created): '/etc' can never
  // be under the mocked home dir '/tmp'.
  describe('db:relocateDatabase (plan 413 path-safety)', () => {
    it('rejects destinations outside the user home directory', async () => {
      vi.mocked(getDatabase).mockReturnValue({ name: '/tmp/origin.db' } as never);
      const result = await invokeHandler('db:relocateDatabase', {}, '/etc');
      expect(result).toEqual({
        success: false,
        error: 'Relocate destination must be inside the user home directory',
      });
    });

    it('rejects a non-string destination', async () => {
      vi.mocked(getDatabase).mockReturnValue({ name: '/tmp/origin.db' } as never);
      const result = await invokeHandler('db:relocateDatabase', {}, 42);
      expect(result).toEqual({ success: false, error: 'Invalid destination directory' });
    });
  });

  // ==================== Plan 549 Track A: archive / unarchive handlers ====================
  // The handler itself is a one-line forward to the Host archive operations
  // (`getDesktopHostSessionApi().archive/unarchive`). The mock wires those to
  // the REAL Host implementation over the mocked core stores, so the archive
  // contract below (lock preflight, subtree walk, file moves, two-phase
  // commit) is asserted against production code.

  describe('db:session:archive (Plan 549 / 582 G2)', () => {
    it('reports not_found for an unknown session id', async () => {
      mocks.stores.sessions.get.mockReturnValueOnce(undefined);
      const result = await invokeHandler('db:session:archive', {}, 'missing');
      expect(result).toEqual({ ok: false, reason: 'not_found', sessionId: 'missing' });
    });

    it('flips status to archived without touching files when the session has no rollout', async () => {
      // The handler reads the row twice (root probe, then the planning loop),
      // so this must be a standing implementation rather than a single use.
      mocks.stores.sessions.get.mockImplementation(() => ({
        id: 's-1',
        status: 'active',
        rolloutPath: null,
        archivedAt: null,
        archivedPath: null,
      }));
      mocks.stores.sessions.getRolloutPath.mockReturnValue(null);

      const result = await invokeHandler('db:session:archive', {}, 's-1');
      expect(result).toEqual({ ok: true, archivedSessionIds: ['s-1'] });
      expect(mocks.stores.sessions.update).toHaveBeenCalledWith('s-1', {
        status: 'archived',
        archivedAt: expect.any(Number),
        archivedPath: null,
        rolloutPath: null,
      });
    });

    it('is idempotent — second archive call does not re-update SQL', async () => {
      mocks.stores.sessions.get.mockReturnValueOnce({
        id: 's-1',
        status: 'archived',
        rolloutPath: 'archived/2026-09-18/sessions/rollout-s-1.jsonl',
        archivedAt: 100,
        archivedPath: 'archived/2026-09-18/sessions',
      });
      const result = await invokeHandler('db:session:archive', {}, 's-1');
      expect(result).toEqual({ ok: true, archivedSessionIds: [] });
      expect(mocks.stores.sessions.update).not.toHaveBeenCalled();
    });

    // ─── G2 PHASE 1: runtime-lock preflight ────────────────────────────

    it('refuses with session_busy when the root session still holds a lock', async () => {
      mocks.stores.sessions.get.mockReturnValueOnce({
        id: 's-1',
        status: 'active',
        rolloutPath: null,
        archivedAt: null,
        archivedPath: null,
      });
      mocks.stores.locks.isLocked.mockImplementation((id: string) => id === 's-1');
      mocks.stores.locks.lockOrigin.mockReturnValue('agent');

      const result = await invokeHandler('db:session:archive', {}, 's-1');
      expect(result).toEqual({
        ok: false,
        reason: 'session_busy',
        sessionId: 's-1',
        blockedId: 's-1',
        origin: 'agent',
      });
      // The whole point of the preflight: nothing was written anywhere.
      expect(mocks.stores.sessions.update).not.toHaveBeenCalled();
      expect(mocks.stores.messageLog.collectSessionRolloutFiles).not.toHaveBeenCalled();
    });

    it('refuses the whole batch when a DESCENDANT is running, even if the root is idle', async () => {
      mocks.stores.sessions.get.mockReturnValueOnce({
        id: 'root',
        status: 'active',
        rolloutPath: null,
        archivedAt: null,
        archivedPath: null,
      });
      mocks.stores.spawnEdges.getTree.mockReturnValueOnce([
        { childSessionId: 'child-a' },
        { childSessionId: 'grandchild' },
      ]);
      mocks.stores.locks.isLocked.mockImplementation((id: string) => id === 'grandchild');
      mocks.stores.locks.lockOrigin.mockReturnValue('user');

      const result = await invokeHandler('db:session:archive', {}, 'root');
      expect(result).toMatchObject({
        ok: false,
        reason: 'session_busy',
        sessionId: 'root',
        blockedId: 'grandchild',
        origin: 'user',
      });
      expect(mocks.stores.sessions.update).not.toHaveBeenCalled();
    });

    // ─── G2 PHASE 2/3: subtree coverage ─────────────────────────────────

    it('archives the root and every descendant in the spawn tree', async () => {
      const rows: Record<string, Record<string, unknown>> = {
        root: { id: 'root', status: 'active', rolloutPath: null, archivedAt: null, archivedPath: null },
        'child-a': { id: 'child-a', status: 'active', rolloutPath: null, archivedAt: null, archivedPath: null },
        'child-b': { id: 'child-b', status: 'active', rolloutPath: null, archivedAt: null, archivedPath: null },
      };
      mocks.stores.sessions.get.mockImplementation((id: string) => rows[id] ?? null);
      mocks.stores.spawnEdges.getTree.mockReturnValueOnce([
        { childSessionId: 'child-a' },
        { childSessionId: 'child-b' },
      ]);

      const result = await invokeHandler('db:session:archive', {}, 'root');
      expect(result).toEqual({
        ok: true,
        archivedSessionIds: ['root', 'child-a', 'child-b'],
      });
      for (const id of ['root', 'child-a', 'child-b']) {
        expect(mocks.stores.sessions.update).toHaveBeenCalledWith(
          id,
          expect.objectContaining({ status: 'archived' }),
        );
      }
      // The rollout path cache for every moved session is now stale.
      expect(mocks.stores.messageLog.invalidateRolloutPathCache).toHaveBeenCalledTimes(3);
    });

    it('skips an already-archived descendant instead of re-reporting it', async () => {
      mocks.stores.sessions.get.mockImplementation((id: string) => {
        if (id === 'root')
          return { id: 'root', status: 'active', rolloutPath: null, archivedAt: null, archivedPath: null };
        if (id === 'child') return { id: 'child', status: 'archived', rolloutPath: null, archivedAt: 1, archivedPath: 'archived/x' };
        return null;
      });
      mocks.stores.spawnEdges.getTree.mockReturnValueOnce([{ childSessionId: 'child' }]);

      const result = await invokeHandler('db:session:archive', {}, 'root');
      expect(result).toEqual({ ok: true, archivedSessionIds: ['root'] });
      expect(mocks.stores.sessions.update).toHaveBeenCalledTimes(1);
      expect(mocks.stores.sessions.update).toHaveBeenCalledWith('root', expect.anything());
    });

    it('skips a soft-deleted descendant rather than resurrecting its metadata', async () => {
      mocks.stores.sessions.get.mockImplementation((id: string) => {
        if (id === 'root')
          return { id: 'root', status: 'active', rolloutPath: null, archivedAt: null, archivedPath: null };
        if (id === 'gone') return { id: 'gone', status: 'deleted', rolloutPath: null, archivedAt: null, archivedPath: null };
        return null;
      });
      mocks.stores.spawnEdges.getTree.mockReturnValueOnce([{ childSessionId: 'gone' }]);

      const result = await invokeHandler('db:session:archive', {}, 'root');
      expect(result).toEqual({ ok: true, archivedSessionIds: ['root'] });
    });

    it('dedupes a child that the tree reports through two parents', async () => {
      const seen: string[] = [];
      mocks.stores.sessions.get.mockImplementation((id: string) => {
        seen.push(id);
        return { id, status: 'active', rolloutPath: null, archivedAt: null, archivedPath: null };
      });
      mocks.stores.spawnEdges.getTree.mockReturnValueOnce([
        { childSessionId: 'shared' },
        { childSessionId: 'shared' },
      ]);

      const result = await invokeHandler('db:session:archive', {}, 'root');
      expect(result).toEqual({ ok: true, archivedSessionIds: ['root', 'shared'] });
      expect(seen.filter((id) => id === 'shared')).toHaveLength(1);
    });

    // ─── G2 PHASE 2/3: two-phase commit over the real filesystem ────────

    it('moves every rollout file and repoints the row at the archived directory', async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'duya-archive-'));
      try {
        const srcDir = path.join(root, 'sessions', '2026', '09', '30');
        fs.mkdirSync(srcDir, { recursive: true });
        const segA = path.join(srcDir, 'archive-0.jsonl');
        const segB = path.join(srcDir, 'active.jsonl');
        fs.writeFileSync(segA, '{"a":1}\n');
        fs.writeFileSync(segB, '{"b":1}\n');

        mocks.resolveRolloutRoot.mockReturnValueOnce(root);
        // The Host reads the row twice (root probe, then the planning loop),
        // so this must be a standing implementation rather than a single use.
        mocks.stores.sessions.get.mockImplementation(() => ({
          id: 's-1',
          status: 'active',
          rolloutPath: 'sessions/2026/09/30/active.jsonl',
          archivedAt: null,
          archivedPath: null,
        }));
        mocks.stores.messageLog.collectSessionRolloutFiles.mockReturnValueOnce([segA, segB]);

        const result = (await invokeHandler('db:session:archive', {}, 's-1')) as {
          ok: boolean;
          archivedSessionIds: string[];
        };
        expect(result.ok).toBe(true);

        // Both segments left the live directory...
        expect(fs.readdirSync(srcDir)).toEqual([]);
        // ...and the row records the archive DIRECTORY plus the live segment.
        const patch = mocks.stores.sessions.update.mock.calls[0][1] as {
          archivedPath: string;
          rolloutPath: string;
        };
        expect(patch.archivedPath).toMatch(
          new RegExp(`^archived/\\d{4}-\\d{2}-\\d{2}/sessions/2026/09/30$`),
        );
        expect(patch.rolloutPath).toBe(`${patch.archivedPath}/active.jsonl`);
        // And the bytes really moved.
        expect(
          fs.readFileSync(path.join(root, patch.rolloutPath), 'utf8'),
        ).toBe('{"b":1}\n');
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    });

    it('rolls back earlier files and leaves SQL untouched when a later rename fails', async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'duya-archive-'));
      try {
        const dirA = path.join(root, 'sessions', 'a');
        const dirB = path.join(root, 'sessions', 'b');
        fs.mkdirSync(dirA, { recursive: true });
        fs.mkdirSync(dirB, { recursive: true });
        const fileA = path.join(dirA, 'active.jsonl');
        const fileB = path.join(dirB, 'active.jsonl');
        fs.writeFileSync(fileA, 'A\n');
        fs.writeFileSync(fileB, 'B\n');

        // Park a directory exactly where B's rename has to land, so the move
        // fails after A's has already succeeded. The bucket date comes from
        // the same helper the production path uses, so this cannot drift.
        const destB = path.join(
          root,
          'archived',
          formatArchiveDate(Date.now()),
          'sessions',
          'b',
          'active.jsonl',
        );
        fs.mkdirSync(destB, { recursive: true });

        mocks.resolveRolloutRoot.mockReturnValueOnce(root);
        mocks.stores.sessions.get.mockImplementation((id: string) => ({
          id,
          status: 'active',
          rolloutPath: `sessions/${id}/active.jsonl`,
          archivedAt: null,
          archivedPath: null,
        }));
        mocks.stores.spawnEdges.getTree.mockReturnValueOnce([{ childSessionId: 'b' }]);
        mocks.stores.messageLog.collectSessionRolloutFiles.mockImplementation((id: string) => [
          path.join(root, 'sessions', id, 'active.jsonl'),
        ]);

        const result = await invokeHandler('db:session:archive', {}, 'a');
        expect(result).toEqual({ ok: false, reason: 'io', sessionId: 'a', failedId: 'b' });

        // A's file is back where it started — the batch was all-or-nothing.
        expect(fs.readFileSync(fileA, 'utf8')).toBe('A\n');
        // No row was written, so the database never claimed a move that the
        // filesystem then undid.
        expect(mocks.stores.sessions.update).not.toHaveBeenCalled();
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    });
  });

  describe('db:session:unarchive (Plan 549 / 582)', () => {
    // Plan 582: this handler was registered as bare `session:unarchive` while
    // preload invoked `db:session:unarchive`, so the renderer's unarchive had
    // been rejecting with "No handler registered" since Plan 549. These tests
    // invoke by registered name and therefore could never have caught it —
    // the assertion below is the cheap guard, `e2e/ipc/session-archive.spec.ts`
    // is the one that goes through the real bridge.
    it('is registered under the channel name preload invokes', () => {
      expect(mocks.captured.handle.has('db:session:unarchive')).toBe(true);
    });

    it('returns false for an unknown session id', async () => {
      mocks.stores.sessions.get.mockReturnValueOnce(undefined);
      const result = await invokeHandler('db:session:unarchive', {}, 'missing');
      expect(result).toBe(false);
    });

    it('flips back to active and clears archive metadata when archivedPath is null', async () => {
      mocks.stores.sessions.get.mockReturnValueOnce({
        id: 's-2',
        status: 'archived',
        archivedPath: null,
      });
      const result = await invokeHandler('db:session:unarchive', {}, 's-2');
      expect(result).toBe(true);
      expect(mocks.stores.sessions.update).toHaveBeenCalledWith('s-2', {
        status: 'active',
        archivedAt: null,
        archivedPath: null,
      });
    });

    it('is idempotent — unarchive on an already-active session is a no-op', async () => {
      mocks.stores.sessions.get.mockReturnValueOnce({
        id: 's-3',
        status: 'active',
        archivedPath: null,
      });
      const result = await invokeHandler('db:session:unarchive', {}, 's-3');
      expect(result).toBe(true);
      expect(mocks.stores.sessions.update).not.toHaveBeenCalled();
    });

    // ─── §8.1: restore targets, over the real filesystem ───────────────

    it('restores every segment of a Plan 582 directory archive to its original path', async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'duya-unarchive-'));
      try {
        const archivedDir = path.join(root, 'archived', '2026-09-18', 'sessions', '2026', '09', '01', 's-9');
        fs.mkdirSync(archivedDir, { recursive: true });
        fs.writeFileSync(path.join(archivedDir, 'archive-0.jsonl'), '{"a":1}\n');
        fs.writeFileSync(path.join(archivedDir, 'active.jsonl'), '{"b":1}\n');

        mocks.resolveRolloutRoot.mockReturnValueOnce(root);
        mocks.stores.sessions.get.mockReturnValueOnce({
          id: 's-9',
          status: 'archived',
          rolloutPath: 'archived/2026-09-18/sessions/2026/09/01/s-9/active.jsonl',
          archivedAt: 100,
          archivedPath: 'archived/2026-09-18/sessions/2026/09/01/s-9',
        });

        const result = await invokeHandler('db:session:unarchive', {}, 's-9');
        expect(result).toBe(true);

        // Pure prefix strip: both segments are back in the date tree.
        const restoredDir = path.join(root, 'sessions', '2026', '09', '01', 's-9');
        expect(fs.readFileSync(path.join(restoredDir, 'archive-0.jsonl'), 'utf8')).toBe('{"a":1}\n');
        expect(fs.readFileSync(path.join(restoredDir, 'active.jsonl'), 'utf8')).toBe('{"b":1}\n');
        expect(mocks.stores.sessions.update).toHaveBeenCalledWith('s-9', {
          status: 'active',
          archivedAt: null,
          archivedPath: null,
          rolloutPath: 'sessions/2026/09/01/s-9/active.jsonl',
        });
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    });

    it('restores a Plan 549 file archive to the recorded rollout_path, not a bare basename', async () => {
      // The safety net for rows the boot-time migration could not normalize.
      // A Plan 549 row records a single FILE, so a plain prefix strip would
      // recover only `rollout-s-9.jsonl` and drop it at the rollout root
      // instead of `sessions/2026/09/01/`.
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'duya-unarchive-'));
      try {
        const legacyAbs = path.join(root, 'archived', '2026-09-18', 'rollout-s-9.jsonl');
        fs.mkdirSync(path.dirname(legacyAbs), { recursive: true });
        fs.writeFileSync(legacyAbs, '{"a":1}\n');

        mocks.resolveRolloutRoot.mockReturnValueOnce(root);
        mocks.stores.sessions.get.mockReturnValueOnce({
          id: 's-9',
          status: 'archived',
          rolloutPath: 'sessions/2026/09/01/rollout-s-9.jsonl',
          archivedAt: 100,
          archivedPath: 'archived/2026-09-18/rollout-s-9.jsonl',
        });

        const result = await invokeHandler('db:session:unarchive', {}, 's-9');
        expect(result).toBe(true);

        expect(
          fs.readFileSync(path.join(root, 'sessions', '2026', '09', '01', 'rollout-s-9.jsonl'), 'utf8'),
        ).toBe('{"a":1}\n');
        // The pre-fix destination must stay empty.
        expect(fs.existsSync(path.join(root, 'rollout-s-9.jsonl'))).toBe(false);
        expect(fs.existsSync(legacyAbs)).toBe(false);
        expect(mocks.stores.sessions.update).toHaveBeenCalledWith('s-9', {
          status: 'active',
          archivedAt: null,
          archivedPath: null,
          rolloutPath: 'sessions/2026/09/01/rollout-s-9.jsonl',
        });
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    });
  });
});
