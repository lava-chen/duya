/**
 * electron/services/providers/provider-store-electron.ts
 *
 * Electron-only bridge: wires `ProviderStore` to the live
 * `ConfigManager` and the SQLite-backed `CapabilityDao`. Importing
 * this file pulls in `electron` (via `config/manager.ts`), so it
 * must NOT be imported by unit tests.
 *
 * Production code should import `getProviderStore` from this module;
 * tests should construct `ProviderStore` directly with a fake reader
 * and a no-op DAO.
 */

import { getConfigManager } from '../../config/manager';
import type { ConfigManager } from '../../config/manager';
import { getDatabase } from '../../db/connection';
import type { ApiProvider } from '../../../src/lib/providers/types';
import { ProviderStore, type ProviderStoreReader } from './provider-store';
import { CapabilityDao } from './capability-dao';

class ConfigManagerReader implements ProviderStoreReader {
  private cm: ConfigManager;
  constructor(cm: ConfigManager) {
    this.cm = cm;
  }
  readAll() {
    return this.cm.getAllProviders();
  }
  readOne(id: string) {
    return this.cm.getAllProviders()[id];
  }
  /** @deprecated Use readDefault. */
  readActive() {
    return this.cm.getDefaultProvider();
  }
  readDefault() {
    return this.cm.getDefaultProvider();
  }
  writeAll(map: Record<string, ApiProvider>): boolean {
    return this.cm.setConfig('apiProviders', map, 'renderer');
  }
  onChange(cb: () => void): () => void {
    return this.cm.onConfigChange(cb);
  }
}

let store: ProviderStore | undefined;

export function createDefaultReader(): ProviderStoreReader {
  return new ConfigManagerReader(getConfigManager());
}

/** Lazily construct a real DAO. Tests should pass a fake. */
export function createDefaultDao(): CapabilityDao {
  return new CapabilityDao(getDatabase());
}

export function getProviderStore(): ProviderStore {
  if (!store) {
    store = new ProviderStore(createDefaultReader(), createDefaultDao());
  }
  return store;
}

/** For tests only. */
export function _setProviderStoreForTest(s: ProviderStore | undefined): void {
  store = s;
}

