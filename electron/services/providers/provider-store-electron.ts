/**
 * electron/services/providers/provider-store-electron.ts
 *
 * Electron-only bridge: wires `ProviderStore` to the live
 * `ConfigManager`. Importing this file pulls in `electron` (via
 * `config/manager.ts`), so it must NOT be imported by unit tests.
 *
 * Production code should import `getProviderStore` from this module;
 * tests should construct `ProviderStore` directly with a fake reader.
 */

import { getConfigManager } from '../../config/manager';
import type { ConfigManager } from '../../config/manager';
import type { ApiProvider } from '../../../src/lib/providers/types';
import { ProviderStore, type ProviderStoreReader } from './provider-store';

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
  readActive() {
    return this.cm.getActiveProvider();
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

export function getProviderStore(): ProviderStore {
  if (!store) store = new ProviderStore(createDefaultReader());
  return store;
}

/** For tests only. */
export function _setProviderStoreForTest(s: ProviderStore | undefined): void {
  store = s;
}
