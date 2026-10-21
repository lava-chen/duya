/**
 * apps/desktop/src/main/services/providers/provider-store-electron.ts
 *
 * Electron-only bridge: wires `ProviderStore` to the live
 * `ConfigStore` and the authenticated local Host capability API. Importing
 * this file pulls in `electron` (via `config/manager.ts`), so it
 * must NOT be imported by unit tests.
 *
 * Production code should import `getProviderStore` from this module;
 * tests should construct `ProviderStore` directly with a fake reader
 * and an in-memory capability store.
 */

import { getConfigStore } from '../../config/store-instance';
import { getDesktopHostLocalProviderModelCapabilityApi } from '../../cli/desktop-host-api';
import { ProviderStore, type CapabilityStore, type ModelCapability, type ProviderStoreReader } from './provider-store';
import { ConfigStoreReader } from './provider-store-config';
import type { ProviderModelCapabilityRecord } from '@duya/agent-protocol';

let store: ProviderStore | undefined;

export function createDefaultReader(): ProviderStoreReader {
  return new ConfigStoreReader(getConfigStore());
}

/** Lazily construct the Host-backed override layer. Tests should pass a fake. */
export function createDefaultDao(): CapabilityStore {
  const api = getDesktopHostLocalProviderModelCapabilityApi();
  return {
    async listByProvider(providerId) {
      return (await api.listProviderModelCapabilities(providerId)).map(toModelCapability);
    },
    async getOne(providerId, modelId) {
      const capability = await api.getProviderModelCapability(providerId, modelId);
      return capability ? toModelCapability(capability) : undefined;
    },
    async upsert(capability) {
      return toModelCapability(await api.upsertProviderModelCapability(capability));
    },
    async delete(providerId, modelId) {
      return (await api.deleteProviderModelCapability(providerId, modelId)).success;
    },
  };
}

function toModelCapability(capability: ProviderModelCapabilityRecord): ModelCapability {
  const { reasoningEffortOptions, ...storedFields } = capability;
  return {
    ...storedFields,
    ...(reasoningEffortOptions
      ? { reasoningEffortOptions: [...reasoningEffortOptions] }
      : {}),
  };
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

