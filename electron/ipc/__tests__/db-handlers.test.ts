/**
 * db-handlers.test.ts — Per-handler forwarding correctness for the core
 * DB IPC channels (plan 328 Phase 2.4).
 *
 * Coverage:
 *   - session:* / message:* / lock:* / task:* / permission:* / search:*
 *     channels forward to the right core-store method with correctly
 *     mapped args and return the adapter-shaped row.
 *   - Decision 3: db:message:replace → appendBatch (not a separate replace).
 *   - Decision 5: db:session:delete is a soft delete (status='deleted');
 *     db:session:list filters out automation mode; db:message:add uses
 *     INSERT OR IGNORE semantics via appendBatch.
 *   - Decision 7: db:search:sessions combines sessions.search +
 *     messageLog.searchText.
 *   - Errors from store methods propagate through the handler.
 *
 * Pattern mirrors logger-handlers.test.ts / git-handlers.test.ts: all
 * mock state lives in vi.hoisted() so the vi.mock() factories (also
 * hoisted) and test bodies share one singleton.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

// All mock state lives in vi.hoisted so the vi.mock factory closures
// (also hoisted) and the test bodies see the same singleton.
const mocks = vi.hoisted(() => {
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

  // permission-resolver — returns a resolved profile string.
  const resolvePermissionProfile = vi.fn(() => 'default');

  // ─── Mock stores (returned by getCoreStores()) ───
  // Each store method is a vi.fn with a default implementation so tests
  // can override return values per-call via mockReturnValueOnce without
  // losing the defaults for un-overridden calls.
  const sessions = {
    create: vi.fn((input: Record<string, unknown>) => ({
      id: input.id,
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
      createdAt: 1000,
      updatedAt: 1000,
    })),
    get: vi.fn(() => undefined),
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
    listBySession: vi.fn(() => []),
    getCount: vi.fn(() => 0),
    getCountByKind: vi.fn(() => 0),
    deleteBySession: vi.fn(),
    searchText: vi.fn(() => []),
    rewriteSession: vi.fn(),
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

  const coreDb = { db: {} };
  const stores = { coreDb, messageLog, sessions, mailbox, tasks, permissions, locks };

  // ─── Mock adapters (core-db-adapters) ───
  // Each adapter returns a recognizable tagged object so tests can assert
  // that the handler forwards the adapter's output (not a re-implementation
  // of the mapping logic). The tagged shape also makes return-value
  // assertions resilient to unrelated field changes in the real adapters.
  const adapters = {
    ipcSessionToCoreCreate: vi.fn(
      (data: Record<string, unknown>, permissionMode: string) => ({
        __tag: 'coreCreate',
        id: data.id,
        permissionMode,
      }),
    ),
    ipcSessionToUpdate: vi.fn((data: Record<string, unknown>) => ({
      __tag: 'coreUpdate',
      ...data,
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
  };

  return { captured, logger, resolvePermissionProfile, stores, adapters };
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

vi.mock('../../db/permission-resolver', () => ({
  resolvePermissionProfile: mocks.resolvePermissionProfile,
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

// ─── Helper ───

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
    // vi.clearAllMocks clears call history for every vi.fn while
    // preserving their default implementations (set in vi.hoisted).
    vi.clearAllMocks();
    mocks.captured.handle.clear();
    registerDbHandlers();
  });

  // ==================== Session Handlers ====================

  describe('db:session:create', () => {
    it('forwards to sessions.create via adapter and returns coreSessionToIpcRow', async () => {
      const data = {
        id: 's1',
        title: 'Test',
        permission_profile: 'plan',
        working_directory: '/tmp',
      };
      const result = await invokeHandler('db:session:create', {}, data);

      // Permission profile resolved with the explicit profile + parent +
      // trust-override flag before insert.
      expect(mocks.resolvePermissionProfile).toHaveBeenCalledWith(
        'plan',
        null,
        { isTrustedOverride: false },
      );
      // Adapter maps the IPC DTO → core create input.
      expect(mocks.adapters.ipcSessionToCoreCreate).toHaveBeenCalledWith(
        data,
        'default',
      );
      // Store receives the adapter's output, not the raw DTO.
      expect(mocks.stores.sessions.create).toHaveBeenCalledTimes(1);
      const createArg = mocks.stores.sessions.create.mock.calls[0][0] as Record<
        string,
        unknown
      >;
      expect(createArg).toMatchObject({ __tag: 'coreCreate', id: 's1' });
      // Return shape is the adapter-mapped row.
      expect(mocks.adapters.coreSessionToIpcRow).toHaveBeenCalledTimes(1);
      expect(result).toMatchObject({ __tag: 'ipcRow', id: 's1' });
    });

    it('propagates errors from sessions.create', async () => {
      mocks.stores.sessions.create.mockImplementationOnce(() => {
        throw new Error('db locked');
      });
      await expect(
        invokeHandler('db:session:create', {}, { id: 's1' }),
      ).rejects.toThrow('db locked');
    });
  });

  describe('db:session:get', () => {
    it('returns coreSessionToIpcRow when found', async () => {
      const session = { id: 's1', status: 'active', updatedAt: 1000 };
      mocks.stores.sessions.get.mockReturnValueOnce(session);
      const result = await invokeHandler('db:session:get', {}, 's1');

      expect(mocks.stores.sessions.get).toHaveBeenCalledWith('s1');
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
      const updated = { id: 's1', status: 'active', updatedAt: 2000 };
      // sessions.get is called again after update to read back the row.
      mocks.stores.sessions.get.mockReturnValueOnce(updated);
      const data = { title: 'New', system_prompt: 'sys' };
      const result = await invokeHandler('db:session:update', {}, 's1', data);

      expect(mocks.adapters.ipcSessionToUpdate).toHaveBeenCalledWith(data);
      expect(mocks.stores.sessions.update).toHaveBeenCalledTimes(1);
      const [idArg, patchArg] = mocks.stores.sessions.update.mock
        .calls[0] as [string, Record<string, unknown>];
      expect(idArg).toBe('s1');
      expect(patchArg).toMatchObject({ __tag: 'coreUpdate', title: 'New' });
      // system_prompt is an extension-bound field — written via setExtension.
      expect(mocks.stores.sessions.setExtension).toHaveBeenCalledWith(
        's1',
        'system_prompt',
        'sys',
      );
      expect(result).toMatchObject({ __tag: 'ipcRow', id: 's1' });
    });
  });

  describe('db:session:delete', () => {
    it('soft-deletes via sessions.update({status:"deleted"}) — never calls sessions.delete (decision 5)', async () => {
      mocks.stores.sessions.get.mockReturnValueOnce({
        id: 's1',
        status: 'active',
      });
      const result = await invokeHandler('db:session:delete', {}, 's1');

      expect(result).toBe(true);
      expect(mocks.stores.sessions.update).toHaveBeenCalledWith('s1', {
        status: 'deleted',
      });
      expect(mocks.stores.sessions.delete).not.toHaveBeenCalled();
    });

    it('returns false when session does not exist', async () => {
      const result = await invokeHandler('db:session:delete', {}, 'missing');
      expect(result).toBe(false);
      expect(mocks.stores.sessions.update).not.toHaveBeenCalled();
    });
  });

  describe('db:session:list', () => {
    it('lists with excludeModes:["automation"] and maps each row (decision 5)', async () => {
      mocks.stores.sessions.list.mockReturnValueOnce([
        { id: 's1', status: 'active', updatedAt: 1000 },
        { id: 's2', status: 'active', updatedAt: 2000 },
      ]);
      const result = (await invokeHandler('db:session:list', {})) as unknown[];

      expect(mocks.stores.sessions.list).toHaveBeenCalledWith({
        excludeModes: ['automation'],
      });
      expect(mocks.adapters.coreSessionToIpcRow).toHaveBeenCalledTimes(2);
      expect(result).toHaveLength(2);
      expect((result[0] as Record<string, unknown>).id).toBe('s1');
    });
  });

  // ==================== Message Handlers ====================

  describe('db:message:add', () => {
    it('appends a single NewEvent via appendBatch and reads back the row (decision 5)', async () => {
      const data = {
        id: 'm1',
        session_id: 's1',
        role: 'user',
        content: 'hi',
      };
      // appendBatch writes; listBySession reads back the stored event so
      // the handler can return the canonical row shape.
      mocks.stores.messageLog.listBySession.mockReturnValueOnce([
        { id: 'm1', sessionId: 's1', seq: 0, payload: '{}', createdAt: 1000 },
      ]);
      const result = await invokeHandler('db:message:add', {}, data);

      expect(mocks.adapters.ipcMessageToNewEvent).toHaveBeenCalledWith(
        's1',
        data,
      );
      // Decision 5: appendBatch (INSERT OR IGNORE), not a replace path.
      expect(mocks.stores.messageLog.appendBatch).toHaveBeenCalledTimes(1);
      const batchArg = mocks.stores.messageLog.appendBatch.mock
        .calls[0][0] as unknown[];
      expect(batchArg).toHaveLength(1);
      expect(batchArg[0]).toMatchObject({
        __tag: 'newEvent',
        id: 'm1',
        sessionId: 's1',
      });
      expect(mocks.adapters.storedEventToIpcMessage).toHaveBeenCalledTimes(1);
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
    it('forwards to messageLog.listBySession and maps via storedEventsToIpcMessages', async () => {
      const events = [
        { id: 'm1', sessionId: 's1', seq: 0, payload: '{}', createdAt: 1000 },
        { id: 'm2', sessionId: 's1', seq: 1, payload: '{}', createdAt: 1001 },
      ];
      mocks.stores.messageLog.listBySession.mockReturnValueOnce(events);
      const result = (await invokeHandler(
        'db:message:getBySession',
        {},
        's1',
      )) as unknown[];

      expect(mocks.stores.messageLog.listBySession).toHaveBeenCalledWith('s1');
      expect(mocks.adapters.storedEventsToIpcMessages).toHaveBeenCalledWith(
        events,
      );
      expect(result).toHaveLength(2);
    });
  });

  describe('db:message:getCount', () => {
    it('returns the count from messageLog.getCount', async () => {
      mocks.stores.messageLog.getCount.mockReturnValueOnce(42);
      const result = await invokeHandler('db:message:getCount', {}, 's1');
      expect(mocks.stores.messageLog.getCount).toHaveBeenCalledWith('s1');
      expect(result).toBe(42);
    });
  });

  describe('db:message:replace', () => {
    it('auto-creates a missing session and appends events via appendBatch (decision 3)', async () => {
      // sessions.get returns undefined → auto-create path.
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

      expect(mocks.stores.sessions.create).toHaveBeenCalledTimes(1);
      // Decision 3: uses appendBatch, not a separate replace method.
      expect(mocks.stores.messageLog.appendBatch).toHaveBeenCalledTimes(1);
      const batchArg = mocks.stores.messageLog.appendBatch.mock
        .calls[0][0] as unknown[];
      expect(batchArg).toHaveLength(2);
      expect(mocks.adapters.ipcMessageToNewEvent).toHaveBeenCalledTimes(2);
      expect(result).toEqual({
        success: true,
        newGeneration: 0,
        messageCount: 2,
      });
    });

    it('skips session auto-create when the session already exists', async () => {
      mocks.stores.sessions.get.mockReturnValueOnce({
        id: 's1',
        status: 'active',
      });
      await invokeHandler('db:message:replace', {}, 's1', [], 0);
      expect(mocks.stores.sessions.create).not.toHaveBeenCalled();
    });
  });

  // ==================== Lock Handlers ====================

  describe('db:lock:acquire', () => {
    it('forwards (sessionId, lockId, owner, ttlSec) to locks.acquire', async () => {
      const result = await invokeHandler(
        'db:lock:acquire',
        {},
        's1',
        'l1',
        'owner-1',
      );
      // Default ttlSec is 300.
      expect(mocks.stores.locks.acquire).toHaveBeenCalledWith(
        's1',
        'l1',
        'owner-1',
        300,
      );
      expect(result).toBe(true);
    });

    it('accepts an explicit ttlSec', async () => {
      await invokeHandler('db:lock:acquire', {}, 's1', 'l1', 'owner-1', 60);
      expect(mocks.stores.locks.acquire).toHaveBeenCalledWith(
        's1',
        'l1',
        'owner-1',
        60,
      );
    });

    it('propagates errors from locks.acquire', async () => {
      mocks.stores.locks.acquire.mockImplementationOnce(() => {
        throw new Error('lock table missing');
      });
      await expect(
        invokeHandler('db:lock:acquire', {}, 's1', 'l1', 'o'),
      ).rejects.toThrow('lock table missing');
    });
  });

  // ==================== Task Handlers ====================

  describe('db:task:create', () => {
    it('forwards to tasks.create via ipcTaskToCoreCreate and returns coreTaskToIpcRow', async () => {
      const data = {
        id: 't1',
        session_id: 's1',
        subject: 'Do thing',
        description: 'Details',
        active_form: 'Doing thing',
        owner: 'agent-1',
      };
      const result = await invokeHandler('db:task:create', {}, data);

      expect(mocks.adapters.ipcTaskToCoreCreate).toHaveBeenCalledWith(data);
      const createArg = mocks.stores.tasks.create.mock.calls[0][0] as Record<
        string,
        unknown
      >;
      expect(createArg).toMatchObject({ __tag: 'taskCreate', id: 't1' });
      expect(mocks.adapters.coreTaskToIpcRow).toHaveBeenCalledTimes(1);
      expect(result).toMatchObject({ __tag: 'taskRow', id: 't1' });
    });
  });

  // ==================== Permission Handlers ====================

  describe('db:permission:create', () => {
    it('forwards to permissions.create via ipcPermissionToCoreCreate', async () => {
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
      const createArg = mocks.stores.permissions.create.mock
        .calls[0][0] as Record<string, unknown>;
      expect(createArg).toMatchObject({ __tag: 'permCreate', id: 'p1' });
      expect(mocks.adapters.corePermissionToIpcRow).toHaveBeenCalledTimes(1);
      expect(result).toMatchObject({ __tag: 'permRow', id: 'p1' });
    });
  });

  // ==================== Search Handlers ====================

  describe('db:search:sessions', () => {
    it('combines sessions.search (metadata) with messageLog.searchText (content) — decision 7', async () => {
      // 1 metadata hit + 1 content hit on a different session.
      mocks.stores.sessions.search.mockReturnValueOnce([
        { id: 's-meta', status: 'active', updatedAt: 1000 },
      ]);
      mocks.stores.messageLog.searchText.mockReturnValueOnce([
        { sessionId: 's-content', messageId: 'm1', seq: 0, snippet: 'hit' },
      ]);
      // sessions.get returns a live session for the content-hit session.
      mocks.stores.sessions.get.mockReturnValueOnce({
        id: 's-content',
        status: 'active',
        updatedAt: 2000,
      });

      const result = (await invokeHandler(
        'db:search:sessions',
        {},
        'query',
      )) as Array<Record<string, unknown>>;

      expect(mocks.stores.sessions.search).toHaveBeenCalledWith('query', 10);
      // remaining = 10 - 1 = 9, so limit passed to searchText is 9 + 5 = 14.
      expect(mocks.stores.messageLog.searchText).toHaveBeenCalledWith('query', {
        limit: 14,
      });
      // Both sources contributed one row.
      expect(result).toHaveLength(2);
      // Sort is updated_at DESC — content hit (2000) ranks above meta hit (1000).
      expect(result[0].id).toBe('s-content');
      expect(result[0].snippet).toBe('hit');
      expect(result[1].id).toBe('s-meta');
      expect(result[1].snippet).toBe('');
    });

    it('skips content hits for deleted sessions', async () => {
      mocks.stores.sessions.search.mockReturnValueOnce([]);
      mocks.stores.messageLog.searchText.mockReturnValueOnce([
        { sessionId: 's-del', messageId: 'm1', seq: 0, snippet: 'hit' },
      ]);
      mocks.stores.sessions.get.mockReturnValueOnce({
        id: 's-del',
        status: 'deleted',
        updatedAt: 2000,
      });
      const result = (await invokeHandler(
        'db:search:sessions',
        {},
        'query',
      )) as unknown[];
      expect(result).toEqual([]);
    });
  });
});
