/**
 * The Host tells the worker when a session's permission mode actually changes.
 *
 * ## The failure this pins
 *
 * The mode a person picks in the TUI is written to the session row, and the
 * row is read when a turn STARTS. A turn already in flight never re-reads
 * it, so the badge changed and the behaviour did not: the agent kept asking
 * for approvals under the old mode until the next turn began.
 *
 * The fix is a second line — the Host pushes the new mode to the running
 * worker — and it hangs off the session API's update, because that is the
 * one place a mode can change. This file pins that the hook fires on a real
 * change and stays quiet otherwise: a hook that fires on every patch would
 * push a command to the worker on every title edit.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { CoreDataHost } from '@duya/data';
import { describe, expect, it } from 'vitest';
import { createHostSessionApi } from '../src/session-api.js';

async function withApi<T>(
  body: (api: ReturnType<typeof createHostSessionApi>, changes: Array<[string, string]>) => Promise<T>,
): Promise<T> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'duya-permission-hook-'));
  const core = new CoreDataHost({
    filename: path.join(root, 'duya-core.db'),
    rolloutRoot: path.join(root, 'sessions'),
    attachmentsRoot: path.join(root, 'attachments'),
    messageLogPorts: {
      botSessionIdPrefix: 'bot:',
      parseBotSessionId: () => null,
      getBotSessionLogPath: (agentId, root) => path.join(root, 'agents', agentId, 'sessions.jsonl'),
      getBotSessionsDir: (agentId, root) => path.join(root, 'agents', agentId, 'sessions'),
    },
  });
  const changes: Array<[string, string]> = [];
  try {
    const api = createHostSessionApi({
      stores: core.stores,
      rolloutRoot: path.join(root, 'sessions'),
      onPermissionModeChanged: (sessionId, profile) => {
        changes.push([sessionId, profile]);
      },
    });
    return await body(api, changes);
  } finally {
    core.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

describe('the session API permission hook', () => {
  it('reports the new profile when a patch changes the mode', async () => {
    await withApi(async (api, changes) => {
      await api.create({ id: 's1' as never, title: 'permission hook' });
      const result = await api.update('s1' as never, undefined, { permissionMode: 'full_access' });

      expect(result.updated).toBe(true);
      expect(changes).toEqual([['s1', 'full_access']]);
    });
  });

  it('stays quiet when the patch repeats the mode the session already has', async () => {
    await withApi(async (api, changes) => {
      await api.create({ id: 's1' as never, title: 'permission hook' });
      await api.update('s1' as never, undefined, { permissionMode: 'auto' });
      changes.length = 0;

      await api.update('s1' as never, undefined, { permissionMode: 'auto' });

      expect(changes).toEqual([]);
    });
  });

  it('stays quiet for a patch that touches nothing about the mode', async () => {
    await withApi(async (api, changes) => {
      await api.create({ id: 's1' as never, title: 'permission hook' });
      changes.length = 0;

      await api.update('s1' as never, undefined, { title: 'renamed' });

      expect(changes).toEqual([]);
    });
  });

  it('reports every real change, so a mode that moves twice reaches the worker twice', async () => {
    await withApi(async (api, changes) => {
      await api.create({ id: 's1' as never, title: 'permission hook' });
      await api.update('s1' as never, undefined, { permissionMode: 'auto' });
      await api.update('s1' as never, undefined, { permissionMode: 'full_access' });

      expect(changes).toEqual([['s1', 'auto'], ['s1', 'full_access']]);
    });
  });
});
