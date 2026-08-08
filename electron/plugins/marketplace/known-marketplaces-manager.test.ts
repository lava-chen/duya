// Plan 334 decision 12 — KnownMarketplacesManager is backed by the
// ConfigStore `marketplaces` block. These tests cover CRUD through a temp
// ConfigStore injected via `_setConfigStoreForTest`.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { ConfigStore } from '../../config/store';
import { _setConfigStoreForTest } from '../../config/store-instance';
import { KnownMarketplacesManager } from './known-marketplaces-manager';
import type { MarketplaceEntry } from './types';

vi.mock('../../logging/logger', () => ({
  getLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
  LogComponent: {
    Main: 'Main',
  },
}));

let dir: string;
let manager: KnownMarketplacesManager;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'duya-marketplaces-'));
  const cfg = new ConfigStore({
    configPath: path.join(dir, 'config.toml'),
    secretsPath: path.join(dir, 'secrets.json'),
  });
  _setConfigStoreForTest(cfg);
  manager = new KnownMarketplacesManager();
});

afterEach(() => {
  _setConfigStoreForTest(undefined);
  fs.rmSync(dir, { recursive: true, force: true });
});

const OFFICIAL: MarketplaceEntry = {
  name: 'DUYA Official Marketplace',
  url: 'https://example.com/marketplace.json',
  description: 'Official',
  autoUpdate: true,
  trusted: true,
};

describe('KnownMarketplacesManager (ConfigStore-backed)', () => {
  it('getAll returns the official default when config is empty', () => {
    const all = manager.getAll();
    expect(Object.keys(all)).toContain('duya-official');
    expect(all['duya-official']).toMatchObject({ autoUpdate: true, trusted: true });
  });

  it('add persists to config and rejects duplicates', () => {
    expect(manager.add('community', OFFICIAL)).toBe(true);
    expect(manager.add('community', OFFICIAL)).toBe(false);
    expect(manager.get('community')).toEqual(OFFICIAL);

    // Persisted to TOML.
    const toml = fs.readFileSync(path.join(dir, 'config.toml'), 'utf-8');
    expect(toml).toContain('community');
  });

  it('update merges partial fields and returns false for unknown key', () => {
    manager.add('community', OFFICIAL);
    expect(manager.update('community', { autoUpdate: false })).toBe(true);
    expect(manager.get('community')?.autoUpdate).toBe(false);
    expect(manager.get('community')?.url).toBe(OFFICIAL.url);

    expect(manager.update('missing', { autoUpdate: false })).toBe(false);
  });

  it('remove deletes a key and returns false for unknown key', () => {
    manager.add('community', OFFICIAL);
    expect(manager.remove('community')).toBe(true);
    expect(manager.get('community')).toBeNull();
    expect(manager.remove('community')).toBe(false);
  });

  it('setEnabled toggles autoUpdate', () => {
    manager.add('community', OFFICIAL);
    expect(manager.setEnabled('community', false)).toBe(true);
    expect(manager.get('community')?.autoUpdate).toBe(false);
  });

  it('reset restores the official default', () => {
    manager.add('community', OFFICIAL);
    const file = manager.reset();
    expect(file.marketplaces['duya-official']).toBeDefined();
    expect(file.marketplaces['community']).toBeUndefined();
    expect(manager.getAll()['duya-official']).toBeDefined();
  });
});