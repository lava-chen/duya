/**
 * The session domain of the standalone Host's worker db bridge.
 *
 * ## Why this file exists
 *
 * The worker owns the conversation, but the Host owns the rows. Two of the
 * worker's session calls were not served by the standalone Host at all:
 *
 * - `session:create` — the write a sub-agent spawn makes for its child row.
 *   Without it the child session never existed, and the run continued as if
 *   it had.
 * - `session:search` — the read behind the session-search tool. Without it
 *   the tool answered "no session matched" for every query.
 *
 * A third call was served, but in the wrong shape: `session:list` answered
 * with the raw core rows, which carry `parentSessionId` and
 * `workingDirectory`, while the worker reads the legacy `parent_id` and
 * `working_directory`. The worker's parent map was therefore empty and the
 * recent-session list was blank.
 *
 * These assertions pin the legacy row shape at the boundary, the create
 * mapping (model, provider, workspace, permission profile, spawn edge), and
 * the fast failure when the Host has not composed the session APIs.
 */
import { describe, expect, it } from 'vitest';
import type {
  HostSessionApiV1,
  HostSessionCreateInput,
  HostSessionPermissionProfileInput,
  HostSessionRecord,
  HostSessionSearchResult,
  HostWorkspaceBinding,
  SessionPermissionProfile,
} from '@duya/agent-protocol/session-api';
import type { CoreSession } from '@duya/data/session-store';
import type { MainDatabase } from '@duya/data/main-database';
import type { MainSettingsStore } from '@duya/data/main-settings-store';
import type { SessionStore } from '@duya/data/session-store';
import type { RunRepository } from '../src/repository-port.js';
import { createHostWorkerDbBridge, WorkerDbBridgeError } from '../src/worker-db-bridge.js';

function coreSession(overrides: Partial<CoreSession> = {}): CoreSession {
  return {
    id: 'session-1',
    title: 'A session',
    workingDirectory: '/tmp/project',
    projectName: 'project',
    status: 'active',
    model: 'gpt-4o',
    permissionMode: 'default',
    providerId: 'openai',
    mode: 'code',
    agentProfileId: null,
    parentSessionId: null,
    agentType: null,
    agentName: null,
    draft: null,
    extensions: {},
    createdAt: 1700,
    updatedAt: 1700,
    ...overrides,
  } as CoreSession;
}

interface BridgeHarness {
  readonly created: HostSessionCreateInput[];
  readonly profiles: HostSessionPermissionProfileInput[];
  readonly registered: string[];
  readonly searches: Array<{ query: string; options: unknown }>;
}

function harness(sessions: CoreSession[]): BridgeHarness & { readonly bridge: ReturnType<typeof createHostWorkerDbBridge> } {
  const created: HostSessionCreateInput[] = [];
  const profiles: HostSessionPermissionProfileInput[] = [];
  const registered: string[] = [];
  const searches: Array<{ query: string; options: unknown }> = [];

  const sessionApi = {
    async resolveSessionPermissionProfile(input: HostSessionPermissionProfileInput) {
      profiles.push(input);
      return 'auto' as SessionPermissionProfile;
    },
    async create(input: HostSessionCreateInput): Promise<HostSessionRecord> {
      created.push(input);
      return { id: input.id ?? 'session-1' } as HostSessionRecord;
    },
    async searchSessions(query: string, options: unknown): Promise<HostSessionSearchResult[]> {
      searches.push({ query, options });
      return [{
        session: { id: sessions[0]?.id ?? 'session-1' } as HostSessionRecord,
        snippet: 'a matching snippet',
        messageId: null,
        sequence: null,
      }];
    },
  } as unknown as HostSessionApiV1;

  const localSessions = {
    async readLocalSession(sessionId: string) {
      return sessions.find((session) => session.id === sessionId) ?? null;
    },
    async listLocalSessions() {
      return { sessions, nextCursor: null };
    },
  };

  const bridge = createHostWorkerDbBridge({
    runs: {} as RunRepository,
    sessions: {} as SessionStore,
    settings: {} as MainSettingsStore,
    mainDatabase: { db: {} } as MainDatabase,
    timeline: sessionApi,
    localSessions,
    workspaceRegistration: {
      async registerLocalDirectory(directory: string): Promise<Extract<HostWorkspaceBinding, { state: 'bound' }>> {
        registered.push(directory);
        return {
          state: 'bound',
          workspaceId: 'workspace-1',
          rootId: 'root-1',
          relativePath: 'project',
        };
      },
    },
  });

  return { bridge, created, profiles, registered, searches };
}

describe('the standalone Host session domain', () => {
  it('lists sessions in the legacy row shape the worker reads', async () => {
    const { bridge } = harness([
      coreSession({ id: 'session-1', parentSessionId: 'session-0' }),
      coreSession({ id: 'session-2', workingDirectory: '/tmp/other' }),
    ]);

    const rows = await bridge.dispatch('session:list', {}) as Array<Record<string, unknown>>;

    expect(rows).toHaveLength(2);
    // The legacy names the worker's session-search tool reads. The raw core
    // rows carry `parentSessionId` / `workingDirectory` and none of these.
    expect(rows[0]).toMatchObject({
      id: 'session-1',
      parent_id: 'session-0',
      working_directory: '/tmp/project',
      project_name: 'project',
      created_at: 1700,
    });
    expect(rows[1]).toMatchObject({ id: 'session-2', working_directory: '/tmp/other' });
  });

  it('filters the listed sessions by working directory', async () => {
    const { bridge } = harness([
      coreSession({ id: 'session-1', workingDirectory: '/tmp/project' }),
      coreSession({ id: 'session-2', workingDirectory: '/tmp/other' }),
    ]);

    const rows = await bridge.dispatch('session:listByWorkingDirectory', {
      workingDirectory: '/tmp/other',
    }) as Array<Record<string, unknown>>;

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: 'session-2' });
  });

  it('searches sessions and answers with the matched snippet', async () => {
    const { bridge, searches } = harness([coreSession({ id: 'session-1' })]);

    const rows = await bridge.dispatch('session:search', {
      query: 'needle',
      opts: { limit: 5 },
    }) as Array<Record<string, unknown>>;

    expect(searches).toEqual([{ query: 'needle', options: { limit: 5, includeContent: true } }]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: 'session-1',
      snippet: 'a matching snippet',
      working_directory: '/tmp/project',
    });
  });

  it('falls back to the default search limit', async () => {
    const { bridge, searches } = harness([coreSession()]);

    await bridge.dispatch('session:search', { query: 'needle' });

    expect(searches[0]?.options).toEqual({ limit: 10, includeContent: true });
  });

  it('rejects a search without a query', async () => {
    const { bridge } = harness([coreSession()]);

    await expect(bridge.dispatch('session:search', {}))
      .rejects.toMatchObject<Partial<WorkerDbBridgeError>>({ code: 'invalid_payload' });
  });

  it('creates the session row the worker asked for', async () => {
    const { bridge, created, registered } = harness([coreSession({ id: 'child-1' })]);

    const row = await bridge.dispatch('session:create', {
      id: 'child-1',
      title: 'Sub: researcher',
      working_directory: '/tmp/project',
      project_name: 'project',
      mode: 'code',
      provider_id: 'openai',
      parent_session_id: 'session-0',
      agent_type: 'sub-agent',
      agent_name: 'researcher',
    }) as Record<string, unknown>;

    expect(registered).toEqual(['/tmp/project']);
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({
      id: 'child-1',
      title: 'Sub: researcher',
      projectName: 'project',
      mode: 'code',
      providerId: 'openai',
      parentSessionId: 'session-0',
      agentType: 'sub-agent',
      agentName: 'researcher',
      workspaceId: 'workspace-1',
      workspaceRootId: 'root-1',
      workspaceRelativePath: 'project',
    });
    // A child row records the spawn edge, so the lineage survives a restart.
    expect(created[0]?.spawn).toEqual({ type: 'subagent' });
    expect(row).toMatchObject({ id: 'child-1', working_directory: '/tmp/project' });
  });

  it('resolves the permission profile before the row is created', async () => {
    const { bridge, profiles, created } = harness([coreSession({ id: 'child-1' })]);

    await bridge.dispatch('session:create', {
      id: 'child-1',
      parent_session_id: 'session-0',
      is_trusted_permission_override: true,
    });

    expect(profiles).toHaveLength(1);
    expect(profiles[0]).toMatchObject({
      parentSessionId: 'session-0',
      trustedOverride: true,
    });
    expect(created[0]?.permissionMode).toBe('auto');
  });

  it('fails fast when the Host has not composed the session APIs', async () => {
    const bridge = createHostWorkerDbBridge({
      runs: {} as RunRepository,
      sessions: {} as SessionStore,
      settings: {} as MainSettingsStore,
      mainDatabase: { db: {} } as MainDatabase,
    });

    await expect(bridge.dispatch('session:create', { id: 'child-1' }))
      .rejects.toMatchObject<Partial<WorkerDbBridgeError>>({ code: 'unimplemented_domain' });
    await expect(bridge.dispatch('session:search', { query: 'needle' }))
      .rejects.toMatchObject<Partial<WorkerDbBridgeError>>({ code: 'unimplemented_domain' });
    await expect(bridge.dispatch('session:list', {}))
      .rejects.toMatchObject<Partial<WorkerDbBridgeError>>({ code: 'unimplemented_domain' });
  });

  it('fails fast when a session with a working directory has no workspace registration', async () => {
    const { bridge } = harness([coreSession()]);
    const withoutWorkspace = createHostWorkerDbBridge({
      runs: {} as RunRepository,
      sessions: {} as SessionStore,
      settings: {} as MainSettingsStore,
      mainDatabase: { db: {} } as MainDatabase,
      timeline: {
        async resolveSessionPermissionProfile() {
          return 'auto' as SessionPermissionProfile;
        },
        async create() {
          return { id: 'child-1' } as HostSessionRecord;
        },
      } as unknown as HostSessionApiV1,
      localSessions: {
        async readLocalSession() {
          return coreSession();
        },
        async listLocalSessions() {
          return { sessions: [], nextCursor: null };
        },
      },
    });
    void bridge;

    await expect(withoutWorkspace.dispatch('session:create', {
      id: 'child-1',
      working_directory: '/tmp/project',
    })).rejects.toMatchObject<Partial<WorkerDbBridgeError>>({ code: 'unimplemented_domain' });
  });
});
