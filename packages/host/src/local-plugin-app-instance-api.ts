import { randomUUID } from 'node:crypto';
import type { HostPluginAppInstanceApiV1 } from '@duya/agent-protocol';
import {
  PluginAppInstanceStoreError,
  type PluginAppInstanceStore,
} from '@duya/data/plugin-app-instance-store';

export class HostPluginAppInstanceApiError extends Error {
  constructor(readonly code: string, readonly status: 400 | 413) {
    super('Invalid Plugin App instance input');
    this.name = 'HostPluginAppInstanceApiError';
  }
}

function mutate<T>(operation: () => T): T {
  try {
    return operation();
  } catch (error) {
    if (error instanceof PluginAppInstanceStoreError &&
        ['invalid_input', 'invalid_state', 'state_too_large'].includes(error.reason)) {
      throw new HostPluginAppInstanceApiError(
        `plugin_app_instance_${error.reason}`,
        error.reason === 'state_too_large' ? 413 : 400,
      );
    }
    throw error;
  }
}

export function createHostPluginAppInstanceApi(store: PluginAppInstanceStore): HostPluginAppInstanceApiV1 {
  return {
    async createPluginAppInstance(input) {
      return mutate(() => store.create({ ...input, instanceId: randomUUID() }));
    },
    async getPluginAppInstance(instanceId) {
      return store.get(instanceId);
    },
    async listPluginAppInstances(pluginId, appId) {
      return appId === undefined ? store.listByPlugin(pluginId) : store.listByApp(pluginId, appId);
    },
    async writePluginAppInstanceState(instanceId, input) {
      return mutate(() => store.writeState({ ...input, instanceId }));
    },
    async setPluginAppInstanceStatus(instanceId, input) {
      return mutate(() => store.setStatus({ ...input, instanceId }));
    },
  };
}
