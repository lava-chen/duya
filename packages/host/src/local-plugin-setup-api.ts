import type { HostLocalPluginSetupApiV1 } from '@duya/agent-protocol/plugin-setup';
import type { PluginSetupStore } from '@duya/data/plugin-setup-store';

export function createHostLocalPluginSetupApi(
  store: PluginSetupStore,
): HostLocalPluginSetupApiV1 {
  return {
    async listPluginSetupValues() {
      return store.listAll();
    },
    async mergePluginSetupValues(pluginId, values) {
      store.merge(pluginId, values);
    },
    async clearPluginSetupValues(pluginId) {
      store.clear(pluginId);
    },
  };
}
