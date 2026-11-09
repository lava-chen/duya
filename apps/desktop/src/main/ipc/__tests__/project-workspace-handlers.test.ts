/**
 * project-workspace-handlers.test.ts — the Project-first IPC channels.
 *
 * ## What is under test
 *
 * The four things the renderer's project view depends on:
 *
 *   - `projects:state` — one read of the whole project state;
 *   - `projects:coordinator:ensure` — the project's coordinator conversation,
 *     created on first use and durable afterwards;
 *   - `session:control:lease:acquire` / `:get` / `:release` — the control
 *     lease, which is what decides who may direct a working session.
 *
 * ## Why the lease assertions are about SHAPE
 *
 * A refused takeover is an ordinary answer, not an error: somebody else holds
 * the session. The handler must report that as `{ success: true, lease: null }`
 * — a failure envelope here would tell the user "the takeover broke" when
 * what happened is "the user may not have this session right now". The lease
 * service itself is exercised by the Host's own tests; what matters here is
 * that the Desktop does not flatten a refusal into an error.
 *
 * The project API mock DELEGATES to the real Host implementation over a real
 * core database, so the projection under test is the real one.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { CoreDataHost } from '@duya/data';
import { createHostProjectApi } from '@duya/host/project-api';
import { createHostSessionInputApi } from '@duya/host/session-input-api';

type Handler = (event: unknown, ...args: unknown[]) => unknown | Promise<unknown>;

type StubSessionApi = {
  get: (id: string, options?: { includeAllSessions?: boolean }) => Promise<unknown>;
  registerLocalDirectory: (directory: string) => Promise<{ state: string; workspaceId: string; rootId: string; relativePath: string } | null>;
  create: (input: Record<string, unknown>) => Promise<{ id: string }>;
};

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, Handler>(),
  hostProjectApi: null as unknown as ReturnType<typeof createHostProjectApi>,
  hostSessionApi: null as unknown as StubSessionApi,
  hostSessionInputApi: null as unknown as ReturnType<typeof createHostSessionInputApi>,
  agentServerPort: null as number | null,
}));

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: Handler) => {
      mocks.handlers.set(channel, fn);
    },
  },
}));

vi.mock('../../cli/desktop-host-api', () => ({
  getDesktopHostProjectApi: () => mocks.hostProjectApi,
  getDesktopHostSessionApi: () => mocks.hostSessionApi,
  getDesktopHostSessionInputApi: () => mocks.hostSessionInputApi,
}));

vi.mock('../../agents/agent-server-lifecycle', () => ({
  getAgentServerPort: () => mocks.agentServerPort,
}));

vi.mock('../../logging/logger', () => ({
  initLogger: vi.fn(),
  getLogger: () => ({
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  }),
  LogComponent: { DB: 'DB', Main: 'Main' },
}));

let dataRoot = '';
let dataHost: CoreDataHost | null = null;
/** The sessions the stub session API knows about, keyed by id. */
let sessions: Map<string, Record<string, unknown>>;
let createdCount: number;

async function invoke(channel: string, ...args: unknown[]): Promise<any> {
  const handler = mocks.handlers.get(channel);
  if (!handler) throw new Error(`No handler registered for channel "${channel}"`);
  return handler({}, ...args);
}

beforeEach(async () => {
  vi.resetModules();
  mocks.handlers.clear();
  dataRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'duya-project-workspace-'));
  dataHost = new CoreDataHost({
    filename: path.join(dataRoot, 'duya-core.db'),
    rolloutRoot: path.join(dataRoot, 'sessions'),
    attachmentsRoot: path.join(dataRoot, 'attachments'),
    messageLogPorts: {
      botSessionIdPrefix: 'bot:',
      parseBotSessionId: () => null,
      getBotSessionLogPath: (agentId: string, root: string) => path.join(root, 'agents', agentId, 'sessions.jsonl'),
      getBotSessionsDir: (agentId: string, root: string) => path.join(root, 'agents', agentId, 'sessions'),
    },
  });
  sessions = new Map();
  createdCount = 0;

  mocks.hostProjectApi = createHostProjectApi(dataHost.stores.projects, dataHost.stores.tasks, {
    sessions: dataHost.stores.sessions,
    spawnEdges: dataHost.stores.spawnEdges,
  });
  mocks.hostSessionInputApi = createHostSessionInputApi({
    stores: dataHost.stores,
    actor: { kind: 'user', id: 'local' },
  });
  mocks.hostSessionApi = {
    get: async (id: string) => sessions.get(id) ?? null,
    registerLocalDirectory: async (directory: string) => ({
      state: 'bound',
      workspaceId: `ws-${directory}`,
      rootId: 'root',
      relativePath: '',
    }),
    create: async (input: Record<string, unknown>) => {
      createdCount += 1;
      const id = `session-${createdCount}`;
      sessions.set(id, { id, ...input });
      return { id };
    },
  };
  mocks.agentServerPort = null;

  const { registerProjectWorkspaceHandlers } = await import('../project-workspace-handlers');
  registerProjectWorkspaceHandlers();
});

describe('projects:state', () => {
  it('answers with the whole project state in one read', async () => {
    const project = await mocks.hostProjectApi.createProject({
      name: 'codex',
      paths: [{ path: '/projects/codex', description: null }],
    });

    const result = await invoke('projects:state', project.project_id);

    expect(result.success).toBe(true);
    expect(result.state.project.name).toBe('codex');
    expect(result.state.tasks).toEqual([]);
    expect(result.state.workSessions).toEqual([]);
  });

  it('answers with a null state for a project that is not there', async () => {
    const result = await invoke('projects:state', 'no-such-project');

    expect(result.success).toBe(true);
    expect(result.state).toBeNull();
  });

  it('refuses a project id that is not a string', async () => {
    const result = await invoke('projects:state', 42);

    expect(result.success).toBe(false);
    expect(result.error).toContain('projectId');
  });
});

describe('projects:coordinator:ensure', () => {
  it('creates the coordinator once and returns the same session afterwards', async () => {
    const project = await mocks.hostProjectApi.createProject({
      name: 'codex',
      paths: [{ path: '/projects/codex', description: null }],
    });

    const first = await invoke('projects:coordinator:ensure', project.project_id);
    expect(first.success).toBe(true);
    expect(first.created).toBe(true);
    expect(first.sessionId).toBe('session-1');

    const second = await invoke('projects:coordinator:ensure', project.project_id);
    expect(second.success).toBe(true);
    expect(second.created).toBe(false);
    expect(second.sessionId).toBe(first.sessionId);
    expect(createdCount).toBe(1);

    // The binding is what makes it durable: it is on the project row.
    const state = await mocks.hostProjectApi.getProjectState(project.project_id);
    expect(state?.coordinatorSessionId).toBe(first.sessionId);
  });

  it('replaces a coordinator whose session is gone', async () => {
    const project = await mocks.hostProjectApi.createProject({
      name: 'codex',
      paths: [{ path: '/projects/codex', description: null }],
    });
    const first = await invoke('projects:coordinator:ensure', project.project_id);
    // The session row is deleted behind the project's back.
    sessions.delete(first.sessionId);

    const second = await invoke('projects:coordinator:ensure', project.project_id);

    expect(second.success).toBe(true);
    expect(second.created).toBe(true);
    expect(second.sessionId).not.toBe(first.sessionId);
  });

  it('refuses a project that does not exist', async () => {
    const result = await invoke('projects:coordinator:ensure', 'no-such-project');

    expect(result.success).toBe(false);
    expect(result.error).toContain('no-such-project');
  });
});

describe('the control lease', () => {
  it('grants the lease, reports it, and gives it back', async () => {
    const acquired = await invoke('session:control:lease:acquire', 'session-1', 'request-1');
    expect(acquired.success).toBe(true);
    expect(acquired.lease).not.toBeNull();
    expect(acquired.lease.sessionId).toBe('session-1');

    const read = await invoke('session:control:lease:get', 'session-1');
    expect(read.lease.leaseId).toBe(acquired.lease.leaseId);

    const released = await invoke('session:control:lease:release', 'session-1', acquired.lease.revision);
    expect(released.success).toBe(true);
    expect(released.released).toBe(true);

    const after = await invoke('session:control:lease:get', 'session-1');
    expect(after.lease).toBeNull();
  });

  it('reports a refused takeover as an answer, not as an error', async () => {
    // The Host refuses the grant when the caller asks for a revision it does
    // not hold. That refusal must reach the renderer as "no lease" — not as a
    // failure, because nothing broke: the user simply may not take this
    // session over right now.
    mocks.hostSessionInputApi = {
      ...mocks.hostSessionInputApi,
      async acquireControlLease() {
        return null;
      },
    } as unknown as ReturnType<typeof createHostSessionInputApi>;

    const refused = await invoke('session:control:lease:acquire', 'session-1', 'request-1');
    expect(refused.success).toBe(true);
    expect(refused.lease).toBeNull();
  });

  it('lets the holder extend its own lease, with a new revision', async () => {
    const first = await invoke('session:control:lease:acquire', 'session-1', 'request-1');
    expect(first.lease).not.toBeNull();

    // Asking again as the SAME holder is an extension, not a takeover: the
    // grant succeeds and bumps the revision, which invalidates the old one.
    const again = await invoke('session:control:lease:acquire', 'session-1', 'request-2');
    expect(again.success).toBe(true);
    expect(again.lease).not.toBeNull();
    expect(again.lease.revision).toBeGreaterThan(first.lease.revision);
  });

  it('takes a session over from another holder, and invalidates the old revision', async () => {
    const held = createHostSessionInputApi({
      stores: dataHost!.stores,
      actor: { kind: 'bot', id: 'coordinator' },
    });
    const granted = await held.acquireControlLease({
      sessionId: 'session-1',
      requestId: 'coordinator-request',
      ttlMs: 60_000,
    });
    expect(granted).not.toBeNull();

    // The user takes it over. The grant bumps the revision, so the previous
    // holder's own revision check now fails — which is how a takeover is
    // made safe.
    const taken = await invoke('session:control:lease:acquire', 'session-1', 'user-request');
    expect(taken.success).toBe(true);
    expect(taken.lease.holder.kind).toBe('user');
    expect(taken.lease.revision).toBeGreaterThan(granted!.revision);

    const releasedByTheOldHolder = await held.releaseControlLease('session-1', granted!.revision);
    expect(releasedByTheOldHolder).toBe(false);

    const read = await invoke('session:control:lease:get', 'session-1');
    expect(read.lease.holder.kind).toBe('user');
  });

  it('refuses a release that does not present the revision', async () => {
    const acquired = await invoke('session:control:lease:acquire', 'session-1', 'request-1');

    const released = await invoke('session:control:lease:release', 'session-1', acquired.lease.revision + 99);
    expect(released.success).toBe(true);
    expect(released.released).toBe(false);

    const read = await invoke('session:control:lease:get', 'session-1');
    expect(read.lease).not.toBeNull();
  });

  it('refuses a malformed session id or revision', async () => {
    expect((await invoke('session:control:lease:get', '')).success).toBe(false);
    expect((await invoke('session:control:lease:acquire', 'session-1', '')).success).toBe(false);
    expect((await invoke('session:control:lease:release', 'session-1', 0)).success).toBe(false);
  });
});

describe('projects:workSessionStatus', () => {
  it('answers with an empty map when the Agent Server is not running', async () => {
    mocks.agentServerPort = null;

    const result = await invoke('projects:workSessionStatus', ['session-1']);

    expect(result.success).toBe(true);
    expect(result.statuses).toEqual({});
  });

  it('refuses a payload that is not an array', async () => {
    const result = await invoke('projects:workSessionStatus', 'session-1');

    expect(result.success).toBe(false);
    expect(result.error).toContain('sessionIds');
  });
});
