/**
 * `GET /v1/skills` over HTTP.
 *
 * ## What is under test
 *
 * The ROUTE and the CLIENT METHOD, against a real HTTP server.
 *
 * Four things can go wrong at this boundary and they are not the same
 * failure:
 *
 * 1. A Host that was given no inventory capability must REFUSE (404 with a
 *    named code). An empty list would be a lie — it would say "this user has
 *    no skills" about a Host that simply cannot tell.
 * 2. A Host that CAN answer must answer with the skills AND the project it
 *    listed them for.
 * 3. A session the Host does not know is a different answer from a Host that
 *    cannot say which project — two named 404s, not one.
 * 4. A request without a session id cannot be answered at all: the session
 *    decides which project's skills these are.
 *
 * The last block drives a REAL local Host, because "the route is wired in
 * `local-host.ts`" is a claim about the composition and only the composition
 * can confirm it.
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
import { createHostSkillInventoryApi } from '../src/skills/skill-inventory-api.js';

const TOKEN = 'skill-inventory-test-token';

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

/** A session API whose `get` answers for exactly the listed sessions. */
function sessionApi(known: readonly string[]): HostSessionApiV1 {
  return {
    async get(sessionId: string) {
      return known.includes(sessionId) ? ({ id: sessionId } as never) : null;
    },
  } as unknown as HostSessionApiV1;
}

async function startServer(
  options: Partial<HostSessionHttpServerOptions> & { api?: HostSessionApiV1 },
): Promise<{ origin: string; client: HostSessionHttpClient }> {
  server = new HostSessionHttpServer({
    api: options.api ?? sessionApi(['session-1']),
    taskApi: {} as HostSessionHttpServerOptions['taskApi'],
    token: TOKEN,
    ...options,
  });
  await server.listen();
  const origin = `http://127.0.0.1:${server.port}`;
  return { origin, client: new HostSessionHttpClient(origin, TOKEN) };
}

/** An inventory over a session the Host knows, and no directories at all. */
function inventory(workingDirectory: string | null) {
  return createHostSkillInventoryApi({
    userSkillsDir: path.join(os.tmpdir(), 'duya-skill-inventory-absent'),
    dataRoot: path.join(os.tmpdir(), 'duya-skill-inventory-absent-data'),
    sessions: {
      async readWorkingDirectory(sessionId: string) {
        return sessionId === 'session-1' ? workingDirectory : null;
      },
    },
  });
}

describe('GET /v1/skills', () => {
  it('answers 404 skill_inventory_unavailable when the capability is not wired', async () => {
    const { origin } = await startServer({});

    const response = await fetch(`${origin}/v1/skills?sessionId=session-1`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'skill_inventory_unavailable' },
    });
  });

  it('answers 200 with the skills and the project when the capability is wired', async () => {
    const { origin } = await startServer({
      skillInventoryApi: {
        async listSkills() {
          return {
            skills: [
              {
                id: 'user:alpha',
                name: 'alpha',
                description: 'The alpha skill',
                source: 'user',
                enabled: true,
                userInvocable: true,
              },
            ],
            workingDirectory: '/projects/demo',
          };
        },
      },
    });

    const response = await fetch(`${origin}/v1/skills?sessionId=session-1`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      skills: [
        {
          id: 'user:alpha',
          name: 'alpha',
          description: 'The alpha skill',
          source: 'user',
          enabled: true,
          userInvocable: true,
        },
      ],
      workingDirectory: '/projects/demo',
    });
  });

  it('answers 400 missing_session_id when the session id is absent', async () => {
    const { origin } = await startServer({ skillInventoryApi: inventory('/projects/demo') });

    const response = await fetch(`${origin}/v1/skills`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'missing_session_id' },
    });
  });

  it('answers 404 session_not_found when the session is not on this Host', async () => {
    const { origin } = await startServer({ skillInventoryApi: inventory(null) });

    const response = await fetch(`${origin}/v1/skills?sessionId=session-1`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'session_not_found' },
    });
  });

  it('answers 404 local_session_projection_unavailable when the Host cannot say which project', async () => {
    const { origin } = await startServer({
      skillInventoryApi: createHostSkillInventoryApi({
        userSkillsDir: path.join(os.tmpdir(), 'duya-skill-inventory-absent'),
        dataRoot: path.join(os.tmpdir(), 'duya-skill-inventory-absent-data'),
      }),
    });

    const response = await fetch(`${origin}/v1/skills?sessionId=session-1`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'local_session_projection_unavailable' },
    });
  });

  it('is not swallowed by another matcher', async () => {
    // The path is top-level, next to `/v1/mcps` and `/v1/sessions`. A matcher
    // registered earlier that claimed `/v1/<anything>` would answer "unknown
    // route" here instead of reaching the inventory.
    const { origin } = await startServer({ skillInventoryApi: inventory('/projects/demo') });

    const response = await fetch(`${origin}/v1/skills?sessionId=session-1`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });

    expect(response.status).toBe(200);
  });

  it('answers 405 for a method that is not a read', async () => {
    const { origin } = await startServer({ skillInventoryApi: inventory('/projects/demo') });

    const response = await fetch(`${origin}/v1/skills?sessionId=session-1`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });

    expect(response.status).toBe(405);
  });
});

describe('the Host client method', () => {
  it('reads the skills and the project out of the answer', async () => {
    const { client } = await startServer({
      skillInventoryApi: {
        async listSkills() {
          return {
            skills: [
              {
                id: 'user:alpha',
                name: 'alpha',
                description: 'The alpha skill',
                source: 'user',
                enabled: true,
                userInvocable: true,
              },
            ],
            workingDirectory: '/projects/demo',
          };
        },
      },
    });

    await expect(client.listSkills('session-1')).resolves.toEqual({
      skills: [
        {
          id: 'user:alpha',
          name: 'alpha',
          description: 'The alpha skill',
          source: 'user',
          enabled: true,
          userInvocable: true,
        },
      ],
      workingDirectory: '/projects/demo',
    });
  });

  it('turns the refusal into a typed client error', async () => {
    const { client } = await startServer({});

    await expect(client.listSkills('session-1')).rejects.toMatchObject({
      status: 404,
      code: 'skill_inventory_unavailable',
    });
  });
});

describe('the skills inventory in a running local Host', () => {
  /**
   * Open the same core database the Host serves, so a session written here
   * is a session the Host's session projection reads.
   */
  function openCoreHost(dataRoot: string): CoreDataHost {
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
    return dataHost;
  }

  /** Write a skill directory: a directory named after the skill. */
  async function writeSkill(parent: string, name: string): Promise<void> {
    const directory = path.join(parent, name);
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(
      path.join(directory, 'SKILL.md'),
      `---\nname: ${name}\ndescription: The ${name} skill\n---\n\nBody.\n`,
      'utf8',
    );
  }

  it('answers with the skills of the session\'s own project', async () => {
    const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'duya-skill-inventory-data-'));
    roots.push(dataRoot);
    const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), 'duya-skill-inventory-project-'));
    roots.push(projectDir);
    await writeSkill(path.join(projectDir, '.agent', 'skills'), 'duya-skill-inventory-fixture');
    // A plugin package under the data root: the plugin registry carries no
    // install path, and the plugin packages live under the Electron app's
    // data directory, so this route cannot see one.
    await writeSkill(path.join(dataRoot, 'plugins', 'demo', 'skills'), 'duya-skill-inventory-plugin');

    const dataHost = openCoreHost(dataRoot);
    dataHost.stores.sessions.create({
      id: 'session-skills',
      workingDirectory: projectDir,
      status: 'active',
    });

    const host = await startLocalHost({ dataRoot, port: 0, token: TOKEN, ephemeral: true });
    hosts.push(host);
    const client = new HostSessionHttpClient(host.origin, TOKEN);

    const result = await client.listSkills('session-skills');

    expect(result.workingDirectory).toBe(projectDir);
    const projectSkill = result.skills.find(
      (skill) => skill.name === 'duya-skill-inventory-fixture',
    );
    expect(projectSkill).toMatchObject({
      id: 'project:duya-skill-inventory-fixture',
      source: 'project',
      enabled: true,
      userInvocable: true,
    });
    // The plugin package is not in the list, and no entry claims to be a
    // plugin skill: this route cannot reach the plugin packages, so a client
    // that renders the list never mistakes a plugin skill for a missing one.
    expect(result.skills.map((skill) => skill.name)).not.toContain('duya-skill-inventory-plugin');
    expect(result.skills.every((skill) => skill.source !== 'plugin')).toBe(true);
  });

  it('answers 404 session_not_found for a session this Host does not have', async () => {
    const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'duya-skill-inventory-missing-'));
    roots.push(dataRoot);

    const host = await startLocalHost({ dataRoot, port: 0, token: TOKEN, ephemeral: true });
    hosts.push(host);
    const client = new HostSessionHttpClient(host.origin, TOKEN);

    await expect(client.listSkills('session-that-is-not-here')).rejects.toMatchObject({
      status: 404,
      code: 'session_not_found',
    });
  });
});
