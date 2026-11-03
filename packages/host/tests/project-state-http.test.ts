/**
 * `GET /v1/projects/:id/state` — the unified project state.
 *
 * ## What is under test
 *
 * The projection the Desktop's project workspace reads: the project, its
 * coordinator conversation, its tasks and its working sessions, all from ONE
 * observation.
 *
 * ## Why the sources differ, and why that matters
 *
 * A working session reaches a project two ways, and the difference is the
 * point of the test:
 *
 *   - it was SPAWNED by the coordinator (the spawn lineage), or
 *   - it was BOUND to a project task (the explicit binding).
 *
 * A session can be both, and then the binding wins — it is the stronger fact,
 * because it says WHICH task the session works on. A session that is only
 * spawned is still a working session of the project and must show up; a
 * session that is only bound must show up even though the coordinator never
 * spawned it.
 *
 * A task that is deleted takes its binding with it: the link table cascades on
 * the task, so the project state stops listing it. A database created before
 * that foreign key existed has no such cascade, and there the binding survives
 * its task — the projection still reports it, with the task marked `unknown`,
 * because the binding is a fact and the missing task is a different one.
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CoreDataHost } from '@duya/data';
import type { HostSessionApiV1 } from '@duya/agent-protocol';
import { HostSessionHttpClient } from '../src/http-client.js';
import { HostSessionHttpServer, type HostSessionHttpServerOptions } from '../src/http-server.js';
import { createHostProjectApi } from '../src/project-api.js';

const TOKEN = 'project-state-test-token';

let server: HostSessionHttpServer | null = null;
const roots: string[] = [];
const dataHosts: CoreDataHost[] = [];

afterEach(async () => {
  await server?.close();
  server = null;
  for (const dataHost of dataHosts.splice(0)) dataHost.close();
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

function sessionApi(): HostSessionApiV1 {
  return { async get() { return null; } } as unknown as HostSessionApiV1;
}

async function startProjectStateHost(): Promise<{
  client: HostSessionHttpClient;
  stores: CoreDataHost['stores'];
  dataHost: CoreDataHost;
}> {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'duya-project-state-data-'));
  roots.push(dataRoot);
  const dataHost = new CoreDataHost({
    filename: path.join(dataRoot, 'duya-core.db'),
    rolloutRoot: path.join(dataRoot, 'sessions'),
    attachmentsRoot: path.join(dataRoot, 'attachments'),
    messageLogPorts: {
      botSessionIdPrefix: 'bot:',
      parseBotSessionId: () => null,
      getBotSessionLogPath: (agentId, root) => path.join(root, 'agents', agentId, 'sessions.jsonl'),
      getBotSessionsDir: (agentId, root) => path.join(root, 'agents', agentId, 'sessions'),
    },
  });
  dataHosts.push(dataHost);
  server = new HostSessionHttpServer({
    api: sessionApi(),
    taskApi: {} as HostSessionHttpServerOptions['taskApi'],
    token: TOKEN,
    projectApi: createHostProjectApi(dataHost.stores.projects, dataHost.stores.tasks, {
      sessions: dataHost.stores.sessions,
      spawnEdges: dataHost.stores.spawnEdges,
    }),
  });
  await server.listen();
  return {
    client: new HostSessionHttpClient(`http://127.0.0.1:${server.port}`, TOKEN),
    stores: dataHost.stores,
    dataHost,
  };
}

describe('GET /v1/projects/:id/state', () => {
  it('projects the project, its coordinator, its tasks and its working sessions together', async () => {
    const { client, stores } = await startProjectStateHost();

    const project = await client.createProject({
      name: 'codex',
      paths: [{ path: '/projects/codex', description: null }],
    });

    const coordinator = stores.sessions.create({
      id: 'session-coordinator',
      title: 'codex 协调',
      workingDirectory: '/projects/codex',
    });
    await client.bindCoordinatorSession(project.project_id, coordinator.id);

    stores.tasks.create({
      id: 'task-1',
      sessionId: coordinator.id,
      subject: '实现登录',
      description: '把登录做完',
      status: 'in_progress',
    });
    await client.bindProjectTask(project.project_id, 'task-1', coordinator.id);

    // A working session the coordinator spawned.
    const spawned = stores.sessions.create({
      id: 'session-work',
      title: '登录实现',
      workingDirectory: '/projects/codex',
      parentSessionId: coordinator.id,
    });
    stores.spawnEdges.record({
      parentSessionId: coordinator.id,
      childSessionId: spawned.id,
      spawnType: 'subagent',
    });

    const state = await client.getProjectState(project.project_id);

    expect(state).not.toBeNull();
    expect(state?.project.project_id).toBe(project.project_id);
    expect(state?.coordinatorSessionId).toBe(coordinator.id);
    expect(state?.tasks).toHaveLength(1);
    expect(state?.tasks[0]).toMatchObject({
      taskId: 'task-1',
      subject: '实现登录',
      status: 'in_progress',
      coordinatorSessionId: coordinator.id,
      workSessionId: null,
    });
    expect(state?.workSessions.map((s) => s.sessionId)).toEqual(['session-work']);
    expect(state?.workSessions[0]?.origin).toBe('spawned');
    expect(typeof state?.observedAt).toBe('number');
  });

  it('reports a bound working session as bound, and a spawned one as spawned', async () => {
    const { client, stores } = await startProjectStateHost();

    const project = await client.createProject({
      name: 'codex',
      paths: [{ path: '/projects/codex', description: null }],
    });
    const coordinator = stores.sessions.create({
      id: 'session-coordinator',
      title: 'codex 协调',
      workingDirectory: '/projects/codex',
    });
    await client.bindCoordinatorSession(project.project_id, coordinator.id);

    stores.tasks.create({
      id: 'task-1',
      sessionId: coordinator.id,
      subject: '实现登录',
      description: '',
    });
    await client.bindProjectTask(project.project_id, 'task-1', coordinator.id);

    const bound = stores.sessions.create({
      id: 'session-bound',
      title: '绑定的工作',
      workingDirectory: '/projects/codex',
    });
    await client.bindWorkSession(project.project_id, 'task-1', bound.id);

    const spawned = stores.sessions.create({
      id: 'session-spawned',
      title: '派生的工作',
      workingDirectory: '/projects/codex',
      parentSessionId: coordinator.id,
    });
    stores.spawnEdges.record({
      parentSessionId: coordinator.id,
      childSessionId: spawned.id,
      spawnType: 'subagent',
    });

    const state = await client.getProjectState(project.project_id);

    expect(state?.workSessions.map((s) => s.sessionId).sort()).toEqual(['session-bound', 'session-spawned']);
    const boundEntry = state?.workSessions.find((s) => s.sessionId === 'session-bound');
    expect(boundEntry?.origin).toBe('bound');
    expect(boundEntry?.taskId).toBe('task-1');
    const spawnedEntry = state?.workSessions.find((s) => s.sessionId === 'session-spawned');
    expect(spawnedEntry?.origin).toBe('spawned');
    expect(spawnedEntry?.taskId).toBeNull();
  });

  it('drops the binding when the task row is deleted', async () => {
    const { client, stores } = await startProjectStateHost();

    const project = await client.createProject({
      name: 'codex',
      paths: [{ path: '/projects/codex', description: null }],
    });
    const coordinator = stores.sessions.create({
      id: 'session-coordinator',
      title: 'codex 协调',
      workingDirectory: '/projects/codex',
    });
    await client.bindCoordinatorSession(project.project_id, coordinator.id);

    stores.tasks.create({
      id: 'task-1',
      sessionId: coordinator.id,
      subject: '实现登录',
      description: '',
    });
    await client.bindProjectTask(project.project_id, 'task-1', coordinator.id);
    stores.tasks.delete('task-1');

    const state = await client.getProjectState(project.project_id);

    // The link table cascades on the task, so the binding goes with it. A
    // project must not keep a task that no longer exists.
    expect(state?.tasks).toHaveLength(0);
  });

  it('still reports a binding whose task row is gone', async () => {
    const { client, stores, dataHost } = await startProjectStateHost();

    const project = await client.createProject({
      name: 'codex',
      paths: [{ path: '/projects/codex', description: null }],
    });
    const coordinator = stores.sessions.create({
      id: 'session-coordinator',
      title: 'codex 协调',
      workingDirectory: '/projects/codex',
    });
    await client.bindCoordinatorSession(project.project_id, coordinator.id);

    stores.tasks.create({
      id: 'task-1',
      sessionId: coordinator.id,
      subject: '实现登录',
      description: '',
    });
    await client.bindProjectTask(project.project_id, 'task-1', coordinator.id);

    // A database created before the link table had its foreign key has no
    // cascade, and the binding outlives its task there.
    dataHost.database.db.pragma('foreign_keys = OFF');
    stores.tasks.delete('task-1');
    dataHost.database.db.pragma('foreign_keys = ON');

    const state = await client.getProjectState(project.project_id);

    expect(state?.tasks).toHaveLength(1);
    expect(state?.tasks[0]?.taskId).toBe('task-1');
    expect(state?.tasks[0]?.status).toBe('unknown');
  });

  it('answers 404 for a project that is not there', async () => {
    const { client } = await startProjectStateHost();

    await expect(client.getProjectState('no-such-project')).resolves.toBeNull();
  });
});
