import { describe, expect, it, vi } from 'vitest';
import type { MainDatabase } from '@duya/data/main-database';
import type { MainSettingsStore } from '@duya/data/main-settings-store';
import type { SessionStore } from '@duya/data/session-store';
import type { HostLocalImageAttachment } from '@duya/agent-protocol/session-api';
import type { RunRepository } from '../src/repository-port.js';
import { createHostWorkerDbBridge, WorkerDbBridgeError } from '../src/worker-db-bridge.js';

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
