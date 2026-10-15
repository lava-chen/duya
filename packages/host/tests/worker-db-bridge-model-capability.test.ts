import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import type { MainDatabase } from '@duya/data/main-database';
import type { MainSettingsStore } from '@duya/data/main-settings-store';
import type { SessionStore } from '@duya/data/session-store';
import type { RunRepository } from '../src/repository-port.js';
import { createHostWorkerDbBridge } from '../src/worker-db-bridge.js';

describe('standalone worker model-capability persistence', () => {
  it('writes, reads and deletes the same normalized cache through the Host-owned store', async () => {
    const db = new Database(':memory:');
    db.exec('CREATE TABLE model_capabilities (id TEXT PRIMARY KEY, is_multimodal INTEGER, detected_at INTEGER, detection_method TEXT)');
    const bridge = createHostWorkerDbBridge({
      runs: {} as RunRepository,
      sessions: {} as SessionStore,
      settings: {} as MainSettingsStore,
      mainDatabase: { db } as MainDatabase,
    });
    try {
      await expect(bridge.dispatch('modelCapability:set', {
        modelName: ' GPT-4o ', isMultimodal: true, method: 'heuristic',
      })).resolves.toEqual({ success: true });
      await expect(bridge.dispatch('modelCapability:get', { modelName: 'gpt-4O' })).resolves.toMatchObject({
        id: 'gpt-4o', is_multimodal: 1, detection_method: 'heuristic',
      });
      await expect(bridge.dispatch('modelCapability:delete', { modelName: 'GPT-4O' })).resolves.toEqual({ success: true });
      await expect(bridge.dispatch('modelCapability:get', { modelName: 'gpt-4o' })).resolves.toBeNull();
    } finally {
      db.close();
    }
  });
});
