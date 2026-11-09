/**
 * `/v1/projects` over HTTP.
 *
 * ## What is under test
 *
 * The route, the client methods, and the store behind them. The TUI lists its
 * projects from this route and registers one through it, so the shape that
 * comes back is a contract the picker reads: `paths` must arrive decoded
 * into objects rather than as the JSON string the column holds, and `name`
 * must come back as it was written.
 *
 * Two failures at this boundary look the same from a picker and are not the
 * same fact:
 *
 * 1. A Host that was given no project capability must REFUSE (404 with a
 *    named code). An empty list would be a lie — it would say "this user has
 *    no projects" about a Host that simply cannot tell.
 * 2. A second registration of the same root is a CONFLICT (409), not a
 *    second project. `canonical_root` is UNIQUE, and the TUI reads that
 *    conflict as "someone else registered it first" and names the row
 *    instead of creating another one.
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CoreDataHost } from '@duya/data';
import type { HostSessionApiV1 } from '@duya/agent-protocol';
import { HostSessionHttpClient } from '../src/http-client.js';
import { HostSessionHttpServer, type HostSessionHttpServerOptions } from '../src/http-server.js';
import { startLocalHost, type LocalHostHandle } from '../src/local-host.js';
import { createHostProjectApi } from '../src/project-api.js';

const TOKEN = 'project-api-test-token';

let server: HostSessionHttpServer | null = null;
const hosts: LocalHostHandle[] = [];
const roots: string[] = [];
const dataHosts: CoreDataHost[] = [];

afterEach(async () => {
  await server?.close();
  server = null;
  for (const host of hosts.splice(0)) await host.close();
  for (const dataHost of dataHosts.splice(0)) dataHost.close();
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

/** A session API with nothing in it — the projects route does not use it. */
function sessionApi(): HostSessionApiV1 {
  return {
    async get() {
      return null;
    },
  } as unknown as HostSessionApiV1;
}

async function startServer(
  options: Partial<HostSessionHttpServerOptions> = {},
): Promise<{ origin: string; client: HostSessionHttpClient }> {
  server = new HostSessionHttpServer({
    api: sessionApi(),
    taskApi: {} as HostSessionHttpServerOptions['taskApi'],
    token: TOKEN,
    ...options,
  });
  await server.listen();
  const origin = `http://127.0.0.1:${server.port}`;
  return { origin, client: new HostSessionHttpClient(origin, TOKEN) };
}

/** A Host whose projects are the real rows of a real core database. */
async function startProjectServer(): Promise<{ origin: string; client: HostSessionHttpClient }> {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'duya-project-api-data-'));
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
  // The Task store is part of the real composition: binding a project Task
  // reads the canonical Task record, and an API built without it answers 500.
  const started = await startServer({ projectApi: createHostProjectApi(dataHost.stores.projects, dataHost.stores.tasks) });
  return { ...started, stores: dataHost.stores };
}

describe('GET /v1/projects', () => {
  it('answers 404 project_api_unavailable when the capability is not wired', async () => {
    const { origin } = await startServer();

    const response = await fetch(`${origin}/v1/projects`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'project_api_unavailable' },
    });
  });

  it('answers 200 with an empty list for a Host that has no projects', async () => {
    const { origin } = await startProjectServer();

    const response = await fetch(`${origin}/v1/projects`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ projects: [] });
  });
});

describe('POST /v1/projects', () => {
  it('registers a project and hands the row back with its paths decoded', async () => {
    const { origin, client } = await startProjectServer();

    const created = await client.createProject({
      name: 'codex',
      paths: [{ path: '/projects/codex', description: null }],
    });

    expect(created.name).toBe('codex');
    expect(created.canonical_root).toBe('/projects/codex');
    expect(created.paths).toEqual([{ path: '/projects/codex', description: null }]);

    const listed = await client.listProjects();
    expect(listed.map((project) => project.project_id)).toEqual([created.project_id]);
    expect(listed[0]?.paths).toEqual([{ path: '/projects/codex', description: null }]);
  });

  it('answers 409 project_conflict for a second registration of the same root', async () => {
    const { origin } = await startProjectServer();
    const body = { name: 'codex', paths: [{ path: '/projects/codex', description: null }] };

    const first = await fetch(`${origin}/v1/projects`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    expect(first.status).toBe(201);

    const second = await fetch(`${origin}/v1/projects`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    expect(second.status).toBe(409);
    await expect(second.json()).resolves.toMatchObject({
      error: { code: 'project_conflict' },
    });
  });

  it('refuses a registration with no path', async () => {
    const { origin } = await startProjectServer();

    const response = await fetch(`${origin}/v1/projects`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'empty' }),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'invalid_project' },
    });
  });
});

describe('PATCH /v1/projects', () => {
  it('renames a project and the next list shows the new name', async () => {
    const { origin, client } = await startProjectServer();
    const created = await client.createProject({
      name: 'codex',
      paths: [{ path: '/projects/codex', description: null }],
    });

    const updated = await client.updateProject(created.project_id, { name: 'codex-cli' });
    expect(updated?.name).toBe('codex-cli');

    const listed = await client.listProjects();
    expect(listed[0]?.name).toBe('codex-cli');
  });

  it('answers 404 for a project that is not there', async () => {
    const { origin } = await startProjectServer();

    const response = await fetch(`${origin}/v1/projects/no-such-project`, {
      method: 'PATCH',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'ghost' }),
    });

    expect(response.status).toBe(404);
  });
});

describe('the project list in a running local Host', () => {
  /**
   * The route being wired in `local-host.ts` is a claim about the
   * composition, and only the composition can confirm it. This is the Host
   * the CLI attaches to — the one the TUI lists its projects from.
   */
  it('serves the projects of the core database the Host owns', async () => {
    const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'duya-project-api-host-'));
    roots.push(dataRoot);

    const host = await startLocalHost({ dataRoot, port: 0, token: TOKEN, ephemeral: true });
    hosts.push(host);
    const client = new HostSessionHttpClient(host.origin, TOKEN);

    expect(await client.listProjects()).toEqual([]);

    const created = await client.createProject({
      name: 'codex',
      paths: [{ path: '/projects/codex', description: null }],
    });
    expect(created.name).toBe('codex');

    const listed = await client.listProjects();
    expect(listed.map((project) => project.project_id)).toEqual([created.project_id]);
    expect(listed[0]?.paths).toEqual([{ path: '/projects/codex', description: null }]);
  });
});

describe('GET /v1/sessions/:id/project-context', () => {
  /**
   * The Worker bootstrap used to pass a cwd-derived `projectId`. That lookup
   * cannot tell a Coordinator from a work Session and cannot resolve the work
   * Session's Task. Here the Session id is the ONLY input; the Host derives
   * the project, the role and the task from durable bindings.
   */
  async function projectWithCoordinator(name = 'codex') {
    const { origin, client, stores } = await startProjectServer();
    const project = await client.createProject({
      name,
      paths: [{ path: `/projects/${name}`, description: null }],
    });
    await client.bindCoordinatorSession(project.project_id, `session-${name}-coordinator`);
    return { origin, client, project, stores };
  }

  it('resolves a Coordinator Session and includes accepted decisions in its context', async () => {
    const { client, project } = await projectWithCoordinator();
    await client.updateProjectDecision({
      projectId: project.project_id,
      key: 'arch',
      content: '用 SQLite',
      status: 'accepted',
      expectedRevision: 0,
      source: { type: 'user_message', id: 'user-1' },
    });

    const context = await client.getSessionProjectContext('session-codex-coordinator');

    expect(context).toMatchObject({
      projectId: project.project_id,
      projectName: 'codex',
      role: 'coordinator',
      taskId: null,
    });
    expect(context?.text).toContain('用 SQLite');
    expect(context?.sourceRefs).toEqual(expect.arrayContaining([{ type: 'user_message', id: 'user-1' }]));
  });

  it('resolves a work Session to exactly the Task it was dispatched for', async () => {
    const { client, project, stores } = await projectWithCoordinator();
    // The canonical Task lives in the Task store; the project link only binds
    // it. bindProjectTask refuses an id with no Task record.
    stores.tasks.create({
      id: 'task-1',
      sessionId: 'session-codex-coordinator',
      subject: '实现登录',
      description: '把登录做完',
      status: 'in_progress',
    });
    await client.bindProjectTask(project.project_id, 'task-1', 'session-codex-coordinator');
    // The link table references real Session rows; binding a non-existent
    // work Session would fail the foreign key with an opaque 500.
    stores.sessions.create({
      id: 'session-work', title: '登录实现', workingDirectory: '/projects/codex',
      parentSessionId: 'session-codex-coordinator',
    });
    await client.bindWorkSession(project.project_id, 'task-1', 'session-work');

    const context = await client.getSessionProjectContext('session-work');

    expect(context).toMatchObject({
      projectId: project.project_id,
      role: 'work',
      taskId: 'task-1',
    });
    // `getProjectContext(projectId, taskId)` narrows `Current task` to this
    // Task, instead of listing every open Task in the project.
    expect(context?.text).toContain('task-1');
  });

  it('never lets a Session name another project: the route has no project id input', async () => {
    const { client, project } = await projectWithCoordinator();

    await expect(client.getSessionProjectContext('session-stranger')).resolves.toBeNull();
    // Two projects with two different Coordinator Sessions stay separated even
    // though both would look identical to a cwd reverse-lookup from the Host.
    const second = await client.createProject({
      name: 'other',
      paths: [{ path: '/projects/other', description: null }],
    });
    await client.bindCoordinatorSession(second.project_id, 'session-other-coordinator');

    await expect(client.getSessionProjectContext('session-other-coordinator'))
      .resolves.toMatchObject({ projectId: second.project_id, role: 'coordinator' });
    await expect(client.getSessionProjectContext('session-codex-coordinator'))
      .resolves.toMatchObject({ projectId: project.project_id, role: 'coordinator' });
  });

  it('answers 405 for a write and 404 when the Host has no project capability', async () => {
    const { origin } = await projectWithCoordinator();
    const write = await fetch(`${origin}/v1/sessions/session-codex-coordinator/project-context`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(write.status).toBe(405);

    const { origin: bareOrigin } = await startServer();
    const bare = await fetch(`${bareOrigin}/v1/sessions/session-1/project-context`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(bare.status).toBe(404);
    await expect(bare.json()).resolves.toMatchObject({ error: { code: 'project_api_unavailable' } });
  });
});
