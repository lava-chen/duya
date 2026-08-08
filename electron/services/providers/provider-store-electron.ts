/**
 * electron/services/providers/provider-store-electron.ts
 *
 * Electron-only bridge: wires `ProviderStore` to the live
 * `ConfigStore` and the SQLite-backed `CapabilityDao`. Importing
 * this file pulls in `electron` (via `config/manager.ts`), so it
 * must NOT be imported by unit tests.
 *
 * Production code should import `getProviderStore` from this module;
 * tests should construct `ProviderStore` directly with a fake reader
 * and a no-op DAO.
 */

import { getConfigStore } from '../../config/store-instance';
import { getDatabase } from '../../db/connection';
import { ProviderStore, type ProviderStoreReader } from './provider-store';
import { ConfigStoreReader } from './provider-store-config';
import { CapabilityDao } from './capability-dao';

let store: ProviderStore | undefined;

export function createDefaultReader(): ProviderStoreReader {
  return new ConfigStoreReader(getConfigStore());
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

