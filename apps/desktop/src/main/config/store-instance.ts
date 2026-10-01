/**
 * store-instance.ts — process-wide `ConfigStore` singleton.
 * Wired to the fixed config paths from `compass`.
 */
import path from 'path';
import { ConfigStore } from './store';
import { resolveConfigTomlPath } from './compass';

let store: ConfigStore | undefined;

export function getConfigStore(): ConfigStore {
  if (!store) {
    const configPath = resolveConfigTomlPath();
    const secretsPath = path.join(path.dirname(configPath), 'secrets.json');
    store = new ConfigStore({ configPath, secretsPath });
  }
  return store;
}

/** For tests only. */
export function _setConfigStoreForTest(s: ConfigStore | undefined): void {
  store = s;
}