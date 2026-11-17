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
