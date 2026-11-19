/**
 * project-channels-local-host.test.ts — the composition seam, on a real Host.
 *
 * The domain, the store and the transport each have their own tests. What none
 * of them can prove is that `startLocalHost` actually COMPOSES them: one service
 * over the core database, fed by the injected transport, visible on the handle.
 * A seam that only exists in a type is exactly the "interface defined, nothing
 * wired" failure this file is here to rule out.
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { HostSessionHttpClient } from '../src/http-client.js';
import { startLocalHost, type LocalHostHandle } from '../src/local-host.js';
import { CHANNEL_ID, CONNECTION_TOKEN, FakeTransport, GUILD_ID, MEMBER_ID } from './project-channels-fixture.js';

async function withHost(
  run: (host: LocalHostHandle, client: HostSessionHttpClient) => Promise<void>,
  transport?: FakeTransport,
): Promise<void> {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'duya-channel-host-'));
  const dataRoot = path.join(temporaryRoot, 'data');
  let host: LocalHostHandle | undefined;
  try {
    host = await startLocalHost({
      dataRoot,
      databasePath: path.join(dataRoot, 'databases', 'duya-main.db'),
      rolloutRoot: path.join(dataRoot, 'sessions'),
      attachmentsRoot: path.join(dataRoot, 'attachments'),
      runtimeFilePath: path.join(dataRoot, 'runtime', 'host-api.json'),
      port: 0,
      token: 'project-channel-host-token',
      ...(transport === undefined ? {} : { projectChannelTransport: transport }),
    });
    const client = new HostSessionHttpClient(host.origin, 'project-channel-host-token');
    await run(host, client);
  } finally {
    await host?.close();
    await fs.rm(temporaryRoot, { recursive: true, force: true });
  }
}

describe('project channel composition in the local Host', () => {
  it('composes no channel domain at all when the caller injected no transport', async () => {
    await withHost(async (host) => {
      expect(host.projectChannels).toBeUndefined();
    });
  });

  it('runs the channel control plane over the Host core database', async () => {
    const transport = new FakeTransport();
    await withHost(async (host, client) => {
      expect(host.projectChannels).toBeDefined();
      const project = await client.createProject({
        name: 'Alpha',
        paths: [{ path: os.tmpdir(), description: null }],
      });
      const service = host.projectChannels!;

      const connection = await service.configureDiscordConnection({
        projectId: project.project_id, requestId: 'cfg-1', token: CONNECTION_TOKEN, label: 'Alpha Bot',
      });
      // The Bot identity came from the transport, not from the request.
      expect(connection.botUserId).toBe(transport.identities.get(CONNECTION_TOKEN));
      expect(connection.credentialConfigured).toBe(true);

      const binding = await service.createBinding({
        projectId: project.project_id,
        requestId: 'bind-1',
        connectionId: connection.connectionId,
        guildId: GUILD_ID,
        channelId: CHANNEL_ID,
        allowedUserIds: [MEMBER_ID],
      });

      const overview = await service.getProjectChannels(project.project_id);
      expect(overview?.bindings.map((row) => row.bindingId)).toEqual([binding.bindingId]);
      expect(overview?.connection?.connectionId).toBe(connection.connectionId);
      // The read projection is client-safe: the token never leaves the Host.
      expect(JSON.stringify(overview)).not.toContain(CONNECTION_TOKEN);
    }, transport);
  });
});

/**
 * The control plane as a client actually reaches it: real HTTP, real auth, real
 * core database. The domain tests call the service directly, which cannot show
 * that a route exists, that the project id comes from the path rather than the
 * body, or that the credential never comes back out.
 */
describe('project channel control plane over HTTP', () => {
  const TOKEN = 'project-channel-host-token';

  async function call(
    host: LocalHostHandle,
    method: string,
    path: string,
    body?: unknown,
    authorization: string | null = `Bearer ${TOKEN}`,
  ): Promise<{ status: number; json: any }> {
    const response = await fetch(`${host.origin}${path}`, {
      method,
      headers: {
        ...(authorization === null ? {} : { authorization }),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, json: await response.json().catch(() => null) };
  }

  async function project(client: HostSessionHttpClient, name = 'Alpha'): Promise<string> {
    // Each project needs its own canonical path; a shared tmpdir would collide.
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'duya-channel-project-'));
    const created = await client.createProject({ name, paths: [{ path: workspace, description: null }] });
    return created.project_id;
  }

  it('refuses every channel route without the Host token, and unauth does not leak the shape', async () => {
    const transport = new FakeTransport();
    await withHost(async (host, client) => {
      const projectId = await project(client);
      const anonymous = await call(host, 'GET', `/v1/projects/${projectId}/channels`, undefined, null);
      expect(anonymous.status).toBe(401);
      expect(JSON.stringify(anonymous.json)).not.toContain('binding');

      // A lookalike token is not the token.
      const forged = await call(host, 'GET', `/v1/projects/${projectId}/channels`, undefined, 'Bearer not-the-token');
      expect(forged.status).toBe(403);
      expect(forged.json.error.code).toBe('invalid_bearer_token');
    }, transport);
  });

  it('configures a connection, binds a channel and reads the overview back', async () => {
    const transport = new FakeTransport();
    await withHost(async (host, client) => {
      const projectId = await project(client);
      const configured = await call(host, 'PUT', `/v1/projects/${projectId}/channels/connection`, {
        requestId: 'cfg-http-1', token: CONNECTION_TOKEN, label: 'Alpha Bot',
      });
      expect(configured.status).toBe(200);
      const connectionId = configured.json.connection.connectionId as string;
      expect(configured.json.connection.credentialConfigured).toBe(true);
      // The Bot identity came from the platform, not from the request body.
      expect(configured.json.connection.botUserId).toBe(transport.identities.get(CONNECTION_TOKEN));
      // The credential went in and did not come out.
      expect(JSON.stringify(configured.json)).not.toContain(CONNECTION_TOKEN);

      const bound = await call(host, 'POST', `/v1/projects/${projectId}/channels/bindings`, {
        requestId: 'bind-http-1', connectionId, guildId: GUILD_ID, channelId: CHANNEL_ID,
        allowedUserIds: [MEMBER_ID],
      });
      expect(bound.status).toBe(201);
      expect(bound.json.binding.allowProactive).toBe(false);

      const overview = await call(host, 'GET', `/v1/projects/${projectId}/channels`);
      expect(overview.status).toBe(200);
      expect(overview.json.overview.bindings).toHaveLength(1);
      expect(overview.json.overview.bindings[0].bindingId).toBe(bound.json.binding.bindingId);
      expect(JSON.stringify(overview.json)).not.toContain(CONNECTION_TOKEN);
    }, transport);
  });

  it('takes the project id from the path, so a body cannot redirect the write', async () => {
    const transport = new FakeTransport();
    await withHost(async (host, client) => {
      const alpha = await project(client);
      const beta = await project(client, 'Beta');

      // Beta's id in the body of an Alpha request is ignored, not honoured.
      const configured = await call(host, 'PUT', `/v1/projects/${alpha}/channels/connection`, {
        requestId: 'cfg-cross', token: CONNECTION_TOKEN, projectId: beta,
      });
      expect(configured.status).toBe(200);

      const betaOverview = await call(host, 'GET', `/v1/projects/${beta}/channels`);
      expect(betaOverview.status).toBe(200);
      expect(betaOverview.json.overview.connection).toBeNull();

      // ...and it landed on Alpha, the project the path named.
      const alphaOverview = await call(host, 'GET', `/v1/projects/${alpha}/channels`);
      expect(alphaOverview.json.overview.connection.credentialConfigured).toBe(true);
    }, transport);
  });

  it('refuses a stale revision instead of overwriting a concurrent change', async () => {
    const transport = new FakeTransport();
    await withHost(async (host, client) => {
      const projectId = await project(client);
      const configured = await call(host, 'PUT', `/v1/projects/${projectId}/channels/connection`, {
        requestId: 'cfg-cas-1', token: CONNECTION_TOKEN,
      });
      const revision = configured.json.connection.revision as number;

      const first = await call(host, 'PUT', `/v1/projects/${projectId}/channels/connection`, {
        requestId: 'cfg-cas-2', token: CONNECTION_TOKEN, label: 'renamed', expectedRevision: revision,
      });
      expect(first.status).toBe(200);

      const stale = await call(host, 'PUT', `/v1/projects/${projectId}/channels/connection`, {
        requestId: 'cfg-cas-3', token: CONNECTION_TOKEN, label: 'again', expectedRevision: revision,
      });
      expect(stale.status).toBe(409);
      expect(stale.json.error.code).toBe('stale_revision');
    }, transport);
  });

  it('updates, revokes and disconnects with CAS, and reports the delivery of a missing id as 404', async () => {
    const transport = new FakeTransport();
    await withHost(async (host, client) => {
      const projectId = await project(client);
      const configured = await call(host, 'PUT', `/v1/projects/${projectId}/channels/connection`, {
        requestId: 'cfg-life-1', token: CONNECTION_TOKEN,
      });
      const connectionId = configured.json.connection.connectionId as string;
      const bound = await call(host, 'POST', `/v1/projects/${projectId}/channels/bindings`, {
        requestId: 'bind-life-1', connectionId, guildId: GUILD_ID, channelId: CHANNEL_ID,
        allowedUserIds: [MEMBER_ID],
      });
      const bindingId = bound.json.binding.bindingId as string;

      const patched = await call(host, 'PATCH', `/v1/projects/${projectId}/channels/bindings/${bindingId}`, {
        requestId: 'patch-1', expectedRevision: 1, allowProactive: true,
      });
      expect(patched.status).toBe(200);
      expect(patched.json.binding.allowProactive).toBe(true);

      // Clearing the allowlist is refused at the request, not accepted then undone.
      const cleared = await call(host, 'PATCH', `/v1/projects/${projectId}/channels/bindings/${bindingId}`, {
        requestId: 'patch-2', expectedRevision: patched.json.binding.revision, allowedUserIds: [],
      });
      expect(cleared.status).toBe(400);

      const revoked = await call(host, 'DELETE', `/v1/projects/${projectId}/channels/bindings/${bindingId}`, {
        requestId: 'revoke-1', expectedRevision: patched.json.binding.revision,
      });
      expect(revoked.status).toBe(200);
      expect(revoked.json.binding.enabled).toBe(false);

      const missing = await call(host, 'GET', `/v1/projects/${projectId}/channels/deliveries/does-not-exist`);
      expect(missing.status).toBe(404);

      const disconnected = await call(host, 'POST', `/v1/projects/${projectId}/channels/connection/disconnect`, {
        requestId: 'disconnect-1', connectionId, expectedRevision: configured.json.connection.revision,
      });
      expect(disconnected.status).toBe(200);
      expect(disconnected.json.connection.enabled).toBe(false);
    }, transport);
  });

  it('rejects malformed bodies with a shape error rather than a partial write', async () => {
    const transport = new FakeTransport();
    await withHost(async (host, client) => {
      const projectId = await project(client);
      const noToken = await call(host, 'PUT', `/v1/projects/${projectId}/channels/connection`, {
        requestId: 'cfg-empty', token: '',
      });
      expect(noToken.status).toBe(400);
      expect(noToken.json.error.code).toBe('invalid_request');

      const noMembers = await call(host, 'POST', `/v1/projects/${projectId}/channels/bindings`, {
        requestId: 'bind-empty', connectionId: 'conn-x', guildId: GUILD_ID, channelId: CHANNEL_ID, allowedUserIds: [],
      });
      expect(noMembers.status).toBe(400);

      const unknown = await call(host, 'POST', `/v1/projects/${projectId}/channels/bindings/b1/archive`, {});
      expect(unknown.status).toBe(404);
    }, transport);
  });
});
