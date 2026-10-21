import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { CoreDataHost } from '@duya/data/core-data-host';
import type { MainDatabase } from '@duya/data/main-database';
import type { MainSettingsStore } from '@duya/data/main-settings-store';
import type { SessionStore } from '@duya/data/session-store';
import type { HostLocalImageAttachment } from '@duya/agent-protocol/session-api';
import type { RunRepository } from '../src/repository-port.js';
import { createHostWorkerDbBridge, WorkerDbBridgeError } from '../src/worker-db-bridge.js';
import { createHostSessionApi } from '../src/session-api.js';

const image: HostLocalImageAttachment = {
  id: 'image-1',
  message_id: 'message-1',
  session_id: 'session-1',
  attachment_type: 'image',
  mime_type: 'image/png',
  data: 'base64-image-data',
  original_url: 'https://cdn.minimax.io/image.png',
  created_at: 10,
};

function bridge(imageAttachmentsForSession?: (sessionId: string) => Promise<readonly HostLocalImageAttachment[]>) {
  return createHostWorkerDbBridge({
    runs: {} as RunRepository,
    sessions: {} as SessionStore,
    settings: {} as MainSettingsStore,
    mainDatabase: { db: {} } as MainDatabase,
    ...(imageAttachmentsForSession === undefined ? {} : { imageAttachmentsForSession }),
  });
}

describe('standalone Host worker image attachment bridge', () => {
  it('serves the local image attachment API rows over the worker db channel', async () => {
    const getImages = vi.fn(async (sessionId: string) => sessionId === 'session-1' ? [image] : []);

    await expect(bridge(getImages).dispatch('attachment:getImagesForSession', {
      sessionId: 'session-1',
    })).resolves.toEqual([image]);
    expect(getImages).toHaveBeenCalledWith('session-1');
  });

  it('fails fast when image history is not composed', async () => {
    await expect(bridge().dispatch('attachment:getImagesForSession', {
      sessionId: 'session-1',
    })).rejects.toMatchObject<Partial<WorkerDbBridgeError>>({
      code: 'unimplemented_domain',
    });
  });
});

describe('standalone Host worker timeline bridge', () => {
  it('persists only the matching Host caller run id, never a worker supplied id', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'duya-worker-message-run-'));
    const core = new CoreDataHost({
      filename: path.join(root, 'duya-core.db'),
      rolloutRoot: path.join(root, 'sessions'),
      attachmentsRoot: path.join(root, 'attachments'),
      messageLogPorts: {
        botSessionIdPrefix: 'bot:',
        parseBotSessionId: () => null,
        getBotSessionLogPath: (agentId, dataRoot) => path.join(dataRoot, 'agents', agentId, 'sessions.jsonl'),
        getBotSessionsDir: (agentId, dataRoot) => path.join(dataRoot, 'agents', agentId, 'sessions'),
      },
    });
    try {
      core.stores.sessions.create({ id: 'session-1', createdAt: 1 });
      const timeline = createHostSessionApi({ stores: core.stores, rolloutRoot: path.join(root, 'sessions') });
      const bridge = createHostWorkerDbBridge({
        runs: {} as RunRepository,
        sessions: {} as SessionStore,
        settings: {} as MainSettingsStore,
        mainDatabase: { db: {} } as MainDatabase,
        timeline,
      });

      await expect(bridge.dispatch('message:append', {
        sessionId: 'session-1',
        turnId: 'legacy-turn-id',
        runId: 'forged-payload-run',
        messages: [{
          id: 'message-trusted', role: 'assistant', content: 'same final answer', created_at: 10,
          runId: 'forged-message-run',
        }],
      }, { sessionId: 'session-1', runId: 'trusted-run', epoch: 1 })).resolves.toMatchObject({ success: true });

      const page = await timeline.readMessages('session-1');
      expect(page.messages.map((item) => ({ id: item.id, runId: item.entry.type === 'message' ? item.entry.runId : undefined })))
        .toEqual([{ id: 'message-trusted', runId: 'trusted-run' }]);
    } finally {
      core.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
