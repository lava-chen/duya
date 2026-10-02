/**
 * Plan 474 P3.2: `[agents.<id>.prompt]` is hand-edited toml config without
 * an upsert input surface — re-upserting an agent (e.g. rename from the UI)
 * must preserve the existing prompt table instead of dropping it.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { ConfigStore } from '../store';
import { _setConfigStoreForTest } from '../store-instance';
import { listConfigAgents, upsertConfigAgent } from '../agents';

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'duya-config-agents-prompt-'));
}

let dir: string;
let store: ConfigStore;

beforeEach(() => {
  dir = tmpDir();
  store = new ConfigStore({
    configPath: path.join(dir, 'config.toml'),
    secretsPath: path.join(dir, 'secrets.json'),
  });
  _setConfigStoreForTest(store);
});

afterEach(() => {
  _setConfigStoreForTest(undefined);
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('upsertConfigAgent preserves [agents.<id>.prompt] (plan 474 P3.2)', () => {
  it('keeps the prompt table on re-upsert', () => {
    store.set('agents', {
      alpha: {
        name: 'Alpha',
        prompt: {
          sections: { disable: ['botMemory'] },
          identity: { voice: 'calm' },
        },
      },
    });

    upsertConfigAgent('alpha', { name: 'Renamed' });

    const entry = listConfigAgents()['alpha'];
    expect(entry?.name).toBe('Renamed');
    expect(entry?.prompt?.sections?.disable).toEqual(['botMemory']);
    expect(entry?.prompt?.identity?.voice).toBe('calm');
  });

  it('creates an agent without a prompt table when none existed', () => {
    upsertConfigAgent('beta', { name: 'Beta' });
    const entry = listConfigAgents()['beta'];
    expect(entry?.name).toBe('Beta');
    expect(entry?.prompt).toBeUndefined();
  });
});
