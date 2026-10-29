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
  return startServer({ projectApi: createHostProjectApi(dataHost.stores.projects) });
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
